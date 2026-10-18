'use strict';

/**
 * 桌面歌词 —— Folium mod 主入口（Node 侧）
 *
 * 职责：
 *  1. 创建一个独立、无边框、透明、置顶的「桌面歌词」窗口，只显示一行歌词。
 *  2. 定时从 api.runtime.getPlaybackSnapshot() 读取播放状态与歌词行，推送给窗口。
 *  3. 「锁定」= 窗口鼠标穿透（setIgnoreMouseEvents(true, { forward: true })），
 *     锁定时不接收任何鼠标事件，桌面操作完全不受影响。
 *  4. 窗口上的「上一首 / 下一首 / 播放暂停」按钮把命令排入队列，
 *     由 client 入口（跑在宿主渲染层，拥有 folium.playback 能力）取走并执行。
 */

const fs = require('node:fs');
const path = require('node:path');

// 日志写在 mod 自己的数据目录里。路径取自 api.storage.paths.data，
// 由宿主按 manifest id 拼成绝对路径：自己用 APPDATA 拼的话，macOS / Linux
// 上环境变量为空，会退化成相对当前工作目录的路径。
// 不能写进 mod 目录（会计入内容摘要，导致信任记录失配）；
// 也不该写到 Folia 用户目录根下（那是宿主的地盘）。
let logFile = null;

// 日志只用于排查，超过上限就从头重写，避免无限增长。
const LOG_MAX_BYTES = 1024 * 1024;

function getLogFile(api) {
  if (logFile) return logFile;
  try {
    logFile = path.join(api.storage.paths.data, 'desktop-lyric.log');
  } catch {
    return null; // 没有 filesystem.data 权限时只能放弃写文件
  }
  return logFile;
}

function fileLog(api, message) {
  const file = getLogFile(api);
  if (!file) return;
  try {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* 首次写入 */ }
    const line = `[${new Date().toISOString()}] ${message}\n`;
    if (size + Buffer.byteLength(line) > LOG_MAX_BYTES) {
      fs.writeFileSync(file, line, 'utf8');
      return;
    }
    fs.appendFileSync(file, line, 'utf8');
  } catch { /* 日志失败不影响功能 */ }
}

// 窗口宽度不写死：由渲染层量出文字实际宽度后回报，窗口贴着文字收放。
// 这样拖动区只覆盖文字本身，两侧不会有看不见的大片空白抢桌面点击。
const WIN_W_MIN = 220;
const WIN_W_MAX = 1200;
const WIN_W_DEFAULT = 460;
const WIN_W_MARGIN = 96;
const POLL_MS = 100;
const FONT_MIN = 12;
const FONT_MAX = 48;
const FONT_DEFAULT = 19;
// 没有可显示的歌词行时的占位文字：整首歌都没有歌词 → 未检测到歌词；有歌词但当前是前奏/间奏/纯音乐 → 纯音乐
const NO_LYRIC_TEXT = '未检测到歌词';
const PURE_MUSIC_TEXT = '纯音乐';
// 全局快捷键会抢走其他软件里的同名组合键，所以默认不注册，
// 由用户在模组设置里自己决定要不要开。
const HOTKEY_BINDINGS = {
  lock: 'CommandOrControl+Shift+L',
  visible: 'CommandOrControl+Shift+H',
  next: 'CommandOrControl+Shift+Right',
  prev: 'CommandOrControl+Shift+Left',
  play: 'CommandOrControl+Shift+Space',
  fontUp: 'CommandOrControl+Shift+Up',
  fontDown: 'CommandOrControl+Shift+Down',
};
const COLOR_DEFAULT = { lyric: '#ffffff', meta: '#ffffff' };
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

module.exports = function activate(api) {
  // 绑定 api 后的文件日志：下面所有调用点都直接用这一个。
  const logFile = (message) => fileLog(api, message);
  /** 取得 electron 模块。主进程入口里直接 require 即可。 */
  const getElectron = () => {
    try {
      return require('electron');
    } catch (error) {
      const message = `无法加载 electron 模块 -> ${error.message}`;
      logFile(message);
      throw new Error(message);
    }
  };

  const log = (msg, extra) => {
    api.log.info(`[desktop-lyric] ${msg}`, extra);
    logFile(msg + (extra === undefined ? '' : ` ${JSON.stringify(extra)}`));
  };
  const logErr = (msg, err) => {
    api.log.error(`[desktop-lyric] ${msg}`, err);
    logFile(`ERROR ${msg}: ${err && err.stack ? err.stack : String(err)}`);
  };

  logFile('=== mod 主入口开始激活 ===');
  // 在这里（而不是模块顶层）取 electron：抛错会被 modSystem 捕获并记为 mod 错误，
  // 不会影响 Folia 主进程启动。
  const { BrowserWindow, screen, ipcMain, globalShortcut } = getElectron();

  /** @type {BrowserWindow | null} */
  let win = null;
  let locked = true;
  let fontSize = FONT_DEFAULT;
  /** 歌词 / 作者名颜色（#rrggbb），桌面背景上百花齐放时换一个看得清的。 */
  let colors = { ...COLOR_DEFAULT };
  /** 是否注册全局快捷键（默认关，用户自己开）。 */
  let hotkeysEnabled = false;
  /** 调色板是否展开（展开时窗口要更高）。 */
  let paletteOpen = false;
  let pollTimer = null;
  let lastPushed = '';
  let disposed = false;
  /** 待 client 入口取走的播放控制命令 */
  let pendingCommands = [];

  /** 窗口高度随字号变化：歌名 + 按钮一行、歌词一行，再留一点空隙。 */
  const heightForFont = (size) => Math.round(size * 2.1) + 42;
  /** 调色板展开时额外占的高度。 */
  const PALETTE_EXTRA_HEIGHT = 108;

  // ---------------------------------------------------------------- 位置

  const defaultBounds = () => {
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(WIN_W_MAX, Math.max(WIN_W_MIN, WIN_W_DEFAULT));
    const height = heightForFont(fontSize);
    return {
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + area.height - height - 36,
      width,
      height,
    };
  };

  /** 只把位置夹回屏幕内；宽度交给文字自适应，不沿用旧存档里的死宽度。 */
  const clampToDisplay = (bounds) => {
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(WIN_W_MAX, Math.max(WIN_W_MIN, Number(bounds.width) || WIN_W_DEFAULT));
    const height = heightForFont(fontSize);
    const x = Math.min(Math.max(area.x, Number(bounds.x) || area.x), Math.max(area.x, area.x + area.width - width));
    const y = Math.min(Math.max(area.y, Number(bounds.y) || area.y), Math.max(area.y, area.y + area.height - height));
    return { x, y, width, height };
  };

  /**
   * 按文字实际宽度调整窗口：渲染层量出「歌名行」和「歌词行」谁更宽，
   * 加上左右内边距与按钮条占位，窗口贴着文字收放——拖动区不再有大片空白。
   * 左边界固定，向右伸缩，视觉上文字不会跳。
   */
  const fitWidthToText = (textWidth) => {
    if (!win || win.isDestroyed() || locked) return;
    const content = Math.ceil(Number(textWidth) || 0);
    if (content <= 0) return;
    const want = Math.min(WIN_W_MAX, Math.max(WIN_W_MIN, content + WIN_W_MARGIN));
    const b = win.getBounds();
    const height = heightForFont(fontSize) + (paletteOpen ? PALETTE_EXTRA_HEIGHT : 0);
    if (Math.abs(b.width - want) < 2 && b.height === height) return;
    const area = screen.getPrimaryDisplay().workArea;
    const x = Math.min(Math.max(area.x, b.x), Math.max(area.x, area.x + area.width - want));
    const y = Math.min(Math.max(area.y, b.y), Math.max(area.y, area.y + area.height - height));
    win.setBounds({ x, y, width: want, height });
  };

  /** 调色板展开 / 收起时补上或收回多出来的高度。 */
  const setPaletteOpen = (open) => {
    paletteOpen = Boolean(open);
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const height = heightForFont(fontSize) + (paletteOpen ? PALETTE_EXTRA_HEIGHT : 0);
    if (b.height === height) return;
    const area = screen.getPrimaryDisplay().workArea;
    const y = Math.min(Math.max(area.y, b.y), Math.max(area.y, area.y + area.height - height));
    win.setBounds({ x: b.x, y, width: b.width, height });
  };

  const loadBounds = async () => {
    try {
      const saved = await api.storage.get('windowBounds');
      if (saved && typeof saved === 'object' && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        const area = screen.getPrimaryDisplay().workArea;
        const height = heightForFont(fontSize);
        return {
          x: Math.min(Math.max(area.x, saved.x), Math.max(area.x, area.x + area.width - WIN_W_MIN)),
          y: Math.min(Math.max(area.y, saved.y), Math.max(area.y, area.y + area.height - height)),
          width: Math.min(WIN_W_MAX, Math.max(WIN_W_MIN, WIN_W_DEFAULT)),
          height,
        };
      }
    } catch (error) {
      logErr('读取窗口位置失败', error);
    }
    return defaultBounds();
  };

  const loadFontSize = async () => {
    try {
      const saved = await api.storage.get('fontSize');
      const size = Number(saved);
      if (Number.isFinite(size)) return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(size)));
    } catch (error) {
      logErr('读取字号失败', error);
    }
    return FONT_DEFAULT;
  };

  const loadColors = async () => {
    try {
      const saved = await api.storage.get('colors');
      if (saved && typeof saved === 'object') {
        for (const key of ['lyric', 'meta']) {
          if (COLOR_RE.test(String(saved[key] || ''))) colors[key] = String(saved[key]);
        }
      }
    } catch (error) {
      logErr('读取颜色失败', error);
    }
    return colors;
  };

  const saveBounds = async () => {
    if (!win || win.isDestroyed()) return;
    try {
      const b = win.getBounds();
      await api.storage.set('windowBounds', { x: b.x, y: b.y, width: b.width });
    } catch (error) {
      logErr('保存窗口位置失败', error);
    }
  };

  // ---------------------------------------------------------------- 窗口

  const send = (channel, payload) => {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send(channel, payload);
    } catch (error) {
      logErr(`发送 ${channel} 失败`, error);
    }
  };

  const applyLock = (next) => {
    locked = Boolean(next);
    if (!win || win.isDestroyed()) return locked;
    // 锁定 = 鼠标穿透：桌面上的点击、拖拽、右键全部穿透到下面的窗口
    win.setIgnoreMouseEvents(locked, { forward: true });
    send('desktop-lyric:lock', locked);
    log(`锁定状态: ${locked ? '已锁定（鼠标穿透）' : '未锁定（可拖动 / 可点击）'}`);
    // 记住这次选择，下次启动沿用（启动时不会一上来就锁死）
    void api.storage.set('locked', locked).catch((error) => logErr('保存锁定状态失败', error));
    return locked;
  };

  /** 读上次的锁定状态；没存过就默认不锁，方便一进来就能拖。 */
  const loadLocked = async () => {
    try {
      const saved = await api.storage.get('locked');
      if (typeof saved === 'boolean') locked = saved;
      else locked = false;
    } catch (error) {
      logErr('读取锁定状态失败', error);
      locked = false;
    }
    log(`恢复锁定状态: ${locked ? '已锁定' : '未锁定'}`);
    return locked;
  };

  /** 读用户是否开启过全局快捷键；没存过就不注册。 */
  const loadHotkeysEnabled = async () => {
    try {
      const saved = await api.storage.get('hotkeys');
      hotkeysEnabled = saved === true;
    } catch (error) {
      logErr('读取快捷键设置失败', error);
      hotkeysEnabled = false;
    }
    log(`全局快捷键: ${hotkeysEnabled ? '已开启' : '未开启'}`);
    return hotkeysEnabled;
  };

  /** 调整字号：窗口高度跟着变（底边保持不动），并把新字号推给渲染层。 */
  const applyFontSize = async (next) => {
    const size = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(Number(next) || FONT_DEFAULT)));
    fontSize = size;
    if (win && !win.isDestroyed()) {
      const b = win.getBounds();
      const height = heightForFont(size);
      const bottom = b.y + b.height;
      const area = screen.getPrimaryDisplay().workArea;
      const y = Math.min(Math.max(area.y, bottom - height), area.y + area.height - height);
      win.setBounds({ x: b.x, y, width: b.width, height });
      send('desktop-lyric:font', size);
    }
    try {
      await api.storage.set('fontSize', size);
    } catch (error) {
      logErr('保存字号失败', error);
    }
    log(`字号: ${size}px`);
    return size;
  };

  /** 改颜色：渲染层立刻显示，同时存盘，下次启动还是这个色。 */
  const applyColors = async (target, hex) => {
    const key = target === 'meta' ? 'meta' : 'lyric';
    if (!COLOR_RE.test(String(hex || ''))) {
      log(`忽略非法颜色: ${String(hex)}`);
      return colors;
    }
    colors = { ...colors, [key]: String(hex) };
    send('desktop-lyric:colors', colors);
    try {
      await api.storage.set('colors', colors);
    } catch (error) {
      logErr('保存颜色失败', error);
    }
    log(`颜色: ${key === 'meta' ? '作者名' : '歌词'} = ${hex}`);
    return colors;
  };

  const pushSnapshot = (payload) => {
    const key = JSON.stringify(payload);
    if (key === lastPushed) return;
    lastPushed = key;
    send('desktop-lyric:update', payload);
  };

  const createWindow = async () => {
    const bounds = await loadBounds();
    await loadLocked();
    await loadHotkeysEnabled();
    if (disposed) return;

    win = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      show: false,
      title: '桌面歌词',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });

    // 普通置顶：压住其他普通窗口，但 Folia 主窗口等仍能盖住它。
    // 不用 'screen-saver' —— 那是最顶层，连 Folia 自己都点不到下面的东西了。
    win.setAlwaysOnTop(true, 'normal');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setMenuBarVisibility(false);

    win.once('ready-to-show', () => {
      if (!win || win.isDestroyed()) return;
      win.showInactive();
      applyLock(locked);
      send('desktop-lyric:font', fontSize);
      send('desktop-lyric:colors', colors);
    });

    win.on('moved', () => { void saveBounds(); });
    // 关窗只隐藏，不销毁：窗口一旦销毁就再也打不开，
    // 显示/隐藏快捷键和按钮都会失效，只能重载模组才能恢复。
    win.on('close', (event) => {
      if (disposed || !win) return;
      event.preventDefault();
      win.hide();
      log('窗口已关闭（实际是隐藏，可用快捷键或按钮再次显示）');
    });
    win.on('closed', () => { win = null; });

    await win.loadFile(path.join(__dirname, 'lyric.html'));
    log('桌面歌词窗口已创建');
  };

  // ---------------------------------------------------------------- 歌词

  const pickLine = (lines, position) => {
    if (!Array.isArray(lines) || lines.length === 0) return null;
    let current = null;
    for (const line of lines) {
      const start = Number(line && line.startTime);
      if (!Number.isFinite(start)) continue;
      if (start <= position + 0.001) current = line;
      else break;
    }
    if (!current) return null;
    const text = String(current.fullText || current.text || '').trim();
    if (!text) return null;
    return { text, startTime: Number(current.startTime) || 0, endTime: Number(current.endTime) || 0 };
  };

  /**
   * 决定当前该显示什么文字。永远不会返回空串：
   *  - 有正在唱/刚唱完的歌词行 → 该行歌词
   *  - 这首歌有歌词、但此刻是前奏/间奏/尾奏（没有落在任何行上）→「纯音乐」
   *  - 这首歌根本没有歌词数据 →「未检测到歌词」
   */
  const resolveText = (lines, position) => {
    const list = Array.isArray(lines) ? lines : [];
    const line = pickLine(list, position);
    if (line) return line.text;

    // 有歌词行，但当前时间点没有对应的行 → 纯音乐段落（前奏 / 间奏 / 尾奏）
    const hasRealLine = list.some((item) => {
      const text = String((item && (item.fullText || item.text)) || '').trim();
      return text.length > 0;
    });
    return hasRealLine ? PURE_MUSIC_TEXT : NO_LYRIC_TEXT;
  };

  const tick = () => {
    if (disposed) return;
    let snapshot = null;
    try {
      snapshot = api.runtime.getPlaybackSnapshot();
    } catch (error) {
      logErr('读取播放快照失败', error);
    }

    if (!snapshot) {
      pushSnapshot({ text: '', placeholder: true, state: 'stopped', song: '', artist: '', locked, fontSize });
      return;
    }

    const position = Number(snapshot.position) || 0;
    const state = snapshot.state || 'stopped';
    const song = snapshot.song || {};
    const songName = String(song.name || song.title || '');
    const artist = Array.isArray(song.artists)
      ? song.artists.map((a) => (a && a.name) || '').filter(Boolean).join(' / ')
      : String(song.artist || '');

    // 什么都没在播放（Folia 刚启动、没选歌）时才留空，交给渲染层显示「等待播放」
    const idle = !songName && state === 'stopped';

    pushSnapshot({
      text: idle ? '' : resolveText(snapshot.lines, position),
      placeholder: !idle,
      state,
      song: songName,
      artist,
      position,
      duration: Number(snapshot.duration) || 0,
      locked,
      fontSize,
    });
  };

  // ---------------------------------------------------------------- 命令

  const queueCommand = (command) => {
    pendingCommands.push(command);
    if (pendingCommands.length > 32) pendingCommands = pendingCommands.slice(-32);
    log(`排入播放控制命令: ${command}`);
  };

  const toggleVisible = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isVisible()) {
      win.hide();
      log('已隐藏');
    } else {
      win.showInactive();
      log('已显示');
    }
  };

  const toggleLock = () => applyLock(!locked);

  // ------------------------------------------------------------ 窗口拖动
  // 页面按住歌词时上报屏幕坐标；这里把「按下点 → 当前点」的位移加到窗口原点。
  // 用屏幕坐标而不是鼠标偏移，缩放过 DPI 也不会漂。
  let dragOrigin = null;
  let dragWinOrigin = null;

  const moveByDrag = (point) => {
    if (!win || win.isDestroyed() || !dragOrigin || !point) return;
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!dragWinOrigin) dragWinOrigin = win.getPosition();
    win.setPosition(
      Math.round(dragWinOrigin[0] + (x - dragOrigin.x)),
      Math.round(dragWinOrigin[1] + (y - dragOrigin.y)),
    );
  };

  // 来自歌词窗口的 IPC（只信任本窗口）
  const onWindowCommand = (event, name, arg) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    const text = String(name || '');
    // 调色板选了颜色：command('color', 'lyric:#rrggbb')
    if (text === 'color') {
      const [target, hex] = String(arg || '').split(':');
      void applyColors(target, hex);
      return;
    }
    switch (text) {
      case 'lock': toggleLock(); break;
      case 'unlock': applyLock(false); break;
      case 'close': if (win && !win.isDestroyed()) win.close(); break;
      case 'next': queueCommand('next'); break;
      case 'prev': queueCommand('prev'); break;
      case 'toggle-play': queueCommand('toggle-play'); break;
      case 'hide': toggleVisible(); break;
      case 'tools-hidden': log('工具条已收起'); break;
      case 'tools-shown': log('工具条已展开'); break;
      case 'font-up': void applyFontSize(fontSize + 2); break;
      case 'font-down': void applyFontSize(fontSize - 2); break;
      case 'fit': fitWidthToText(arg); break;
      case 'palette': setPaletteOpen(arg); break;
      // 窗口内按住拖动：页面上报屏幕坐标，主进程算位移后移动窗口。
      // 用页面自绘拖动（而非 -webkit-app-region: drag）是为了保留点击事件。
      case 'drag-start':
        dragOrigin = { x: Number(arg && arg.x), y: Number(arg && arg.y) };
        dragWinOrigin = null;
        break;
      case 'drag-move': moveByDrag(arg); break;
      case 'drag-end':
        dragOrigin = null;
        dragWinOrigin = null;
        void saveBounds();
        break;
      default: log(`未知命令: ${text}`);
    }
  };

  // ---------------------------------------------------------------- 启动

  const start = async () => {
    ipcMain.on('desktop-lyric:command', onWindowCommand);

    fontSize = await loadFontSize();
    await loadColors();

    // client 入口每 250ms 取一次命令并调用 folium.playback.*，
    // 顺便回报锁定状态，让 Folia 界面上的按钮能显示对错状态。
    api.rpc.handle('poll-commands', () => {
      const commands = pendingCommands;
      pendingCommands = [];
      return {
        commands,
        locked,
        visible: Boolean(win && !win.isDestroyed() && win.isVisible()),
      };
    });

    // client 入口回报自身是否就绪（便于排错）
    api.rpc.handle('client-ready', (info) => {
      log('client 入口已就绪', info);
      return {
        ok: true,
        locked,
        visible: Boolean(win && !win.isDestroyed() && win.isVisible()),
        colors,
      };
    });

    // client 入口（Folia 界面里的调色板）设置颜色
    api.rpc.handle('set-color', (target, hex) => {
      void applyColors(target, hex);
      return { ok: true, colors };
    });

    // client 入口（渲染层）写日志到本文件，用于事后核对按钮状态同步是否正常。
    api.rpc.handle('client-log', (message) => {
      logFile(`[client] ${String(message)}`);
      return { ok: true, locked, visible: Boolean(win && !win.isDestroyed() && win.isVisible()) };
    });

    // client 入口（Folia 界面里的锁按钮）→ 在这里切换歌词条状态：
    //   锁定时点一下 = 弹出控制条（解除穿透，可拖动、可点按钮、可调字号）
    //   未锁定时点一下 = 重新锁定（鼠标穿透，打游戏不会误触）
    api.rpc.handle('toggle-tools', () => {
      logFile(`[client] 请求切换控制条（当前 locked=${locked}）`);
      applyLock(!locked);
      if (win && !win.isDestroyed()) {
        win.showInactive();
        win.setBounds(clampToDisplay(win.getBounds()));
      }
      return { ok: true, locked };
    });

    // 开 / 关全局快捷键（默认关）。
    api.rpc.handle('toggle-hotkeys', () => {
      hotkeysEnabled = !hotkeysEnabled;
      if (hotkeysEnabled) registerHotkeys();
      else unregisterHotkeys();
      void api.storage.set('hotkeys', hotkeysEnabled)
        .catch((error) => logErr('保存快捷键设置失败', error));
      log(`全局快捷键: ${hotkeysEnabled ? '开启' : '关闭'}`);
      return { ok: true, hotkeys: hotkeysEnabled };
    });

    await createWindow();
    // 启动途中可能已被停用：此时不能再注册快捷键和定时器，否则它们会残留。
    if (disposed) return;

    if (hotkeysEnabled) registerHotkeys();

    pollTimer = setInterval(tick, POLL_MS);
    tick();
    log('桌面歌词已启动');
  };

  /** 注册全局快捷键。默认不开：这些组合键会抢走其他软件里的同名操作。 */
  const registerHotkeys = () => {
    unregisterHotkeys();
    try {
      const results = {
        lock: globalShortcut.register(HOTKEY_BINDINGS.lock, toggleLock),
        visible: globalShortcut.register(HOTKEY_BINDINGS.visible, toggleVisible),
        next: globalShortcut.register(HOTKEY_BINDINGS.next, () => queueCommand('next')),
        prev: globalShortcut.register(HOTKEY_BINDINGS.prev, () => queueCommand('prev')),
        play: globalShortcut.register(HOTKEY_BINDINGS.play, () => queueCommand('toggle-play')),
        fontUp: globalShortcut.register(HOTKEY_BINDINGS.fontUp, () => { void applyFontSize(fontSize + 2); }),
        fontDown: globalShortcut.register(HOTKEY_BINDINGS.fontDown, () => { void applyFontSize(fontSize - 2); }),
      };
      const failed = Object.keys(results).filter((key) => !results[key]);
      log(`快捷键注册: ${failed.length === 0 ? '全部成功' : `失败 ${failed.join('/')}`}`);
    } catch (error) {
      logErr('注册快捷键失败', error);
    }
  };

  const unregisterHotkeys = () => {
    for (const accelerator of Object.values(HOTKEY_BINDINGS)) {
      try { globalShortcut.unregister(accelerator); } catch { /* ignore */ }
    }
  };

  api.onDispose(() => {
    disposed = true;
    logFile('=== mod 停用 ===');
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    try { ipcMain.removeListener('desktop-lyric:command', onWindowCommand); } catch { /* ignore */ }
    unregisterHotkeys();
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    log('桌面歌词已停止');
  });

  start().catch((error) => logErr('启动失败', error));

  return () => { logFile('dispose 回调'); };
};
