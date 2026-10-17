/**
 * 桌面歌词 —— Folium mod 客户端入口（渲染层，context = 'main'）
 *
 * 职责：
 *  1. 拥有 folium.playback 能力，执行歌词窗口排队的播放控制命令（切歌 / 播放暂停）。
 *  2. 在 Folia 的播放进度条上注册一个功能按键：
 *     点一下就把桌面歌词的控制条「弹出来」（解除锁定，可拖动、可点按钮）。
 *
 * 设计要点（针对「按钮图标状态冻结」问题）：
 *  - 宿主可能挂载多个按钮实例，也可能重挂载；所以用 Set 保存全部实例，
 *    每个实例的清理函数只移除自己，绝不会把别的实例引用清空。
 *  - 点击加 400ms 防抖：避免双击被当成两次切换（两次 toggle 净零，看起来像没反应）。
 *  - 图标用内联 SVG（闭锁 / 开锁），不依赖 emoji 字体，状态一眼可辨。
 *  - 关键动作都通过 rpc 写到主进程日志，便于在不注入输入的情况下核对。
 */

/** 已锁定：闭合的锁。 */
const ICON_LOCKED =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2.5"/>' +
  '<path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>';

/** 未锁定：右侧锁梁抬起的开锁。 */
const ICON_UNLOCKED =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2.5"/>' +
  '<path d="M8 10.5V7.5a4 4 0 0 1 7.6-1.7"/></svg>';

const BUTTON_STYLE = `
  .dl-btn {
    all: unset;
    display: flex; align-items: center; justify-content: center;
    width: 24px; height: 24px;
    border-radius: 6px;
    cursor: pointer;
    color: #d6d3d1;
    opacity: .6;
    transition: opacity .12s ease, background .12s ease, color .12s ease;
  }
  .dl-btn:hover { opacity: 1; background: rgba(255,255,255,.16); }
  .dl-btn:active { background: rgba(255,255,255,.3); }
  /* 未锁定 = 琥珀色高亮，明确提示「控制条正暴露在桌面上」 */
  .dl-btn[data-locked="0"] { opacity: 1; color: #fbbf24; background: rgba(251,191,36,.16); }
  .dl-btn[data-locked="0"]:hover { background: rgba(251,191,36,.3); }
  /* 歌词条被隐藏时压暗 */
  .dl-btn[data-visible="0"] { opacity: .35; }
`;

export default function activate(folium) {
  let stopped = false;
  let polling = false;
  let locked = true;
  let visible = true;
  let lastClickAt = 0;

  /** 全部已挂载的按钮实例（宿主可能挂载多个）。 */
  const buttons = new Set();

  /** 写一行日志到主进程的 desktop-lyric.log，便于事后核对。 */
  const report = (message) => {
    try {
      const pending = folium.rpc.call('client-log', String(message));
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch { /* 日志失败不影响功能 */ }
  };

  // ------------------------------------------------- 歌词时间轴一次性校准
  // 目标：把「设备级全局偏移」固定为 -250ms，并清空逐首偏移字典。
  // Folia 最终偏移 = per-song + device（bootstrap 原文: per-song Xms + device Yms），
  // 全局生效后以后新歌自动 -250，永远不用逐首调。
  // 只在值不正确时才写入，避免每次启动都覆盖用户在界面上做的有意修改。
  const GLOBAL_OFFSET_KEY = 'global_lyric_timeline_offset_ms';
  const PER_TRACK_KEY = 'lyric_timeline_offsets';
  const TARGET_OFFSET_MS = -250;

  const calibrateLyricOffset = () => {
    try {
      const currentGlobal = Number(localStorage.getItem(GLOBAL_OFFSET_KEY));
      const perTrackRaw = localStorage.getItem(PER_TRACK_KEY);
      const perTrackCount = perTrackRaw ? Object.keys(JSON.parse(perTrackRaw)).length : 0;
      const needGlobal = currentGlobal !== TARGET_OFFSET_MS;
      const needClear = perTrackCount > 0;
      if (!needGlobal && !needClear) {
        report(`歌词偏移校准：无需修改（全局=${currentGlobal}ms, 逐首=${perTrackCount} 条）`);
        return;
      }
      if (needGlobal) localStorage.setItem(GLOBAL_OFFSET_KEY, String(TARGET_OFFSET_MS));
      if (needClear) localStorage.removeItem(PER_TRACK_KEY);
      report(`歌词偏移校准完成：全局偏移设为 ${TARGET_OFFSET_MS}ms（原 ${currentGlobal}），清除逐首偏移 ${perTrackCount} 条`);
    } catch (error) {
      report(`歌词偏移校准失败: ${error && error.message ? error.message : String(error)}`);
    }
  };
  calibrateLyricOffset();

  // ------------------------------------------------------------ 播放控制

  const run = async (command) => {
    switch (command) {
      case 'next':
        await folium.playback.next();
        break;
      case 'prev':
        await folium.playback.previous();
        break;
      case 'toggle-play':
        await folium.playback.toggle();
        break;
      default:
        folium.log.warn(`未知播放控制命令: ${String(command)}`);
        return;
    }
    folium.log.info(`已执行播放控制: ${command}`);
  };

  // ------------------------------------------------------------ 界面按键

  /** 把当前状态画到每一个已挂载的按钮上（不依赖任何单一引用）。 */
  const renderButtons = () => {
    for (const btn of buttons) {
      btn.innerHTML = locked ? ICON_LOCKED : ICON_UNLOCKED;
      btn.dataset.locked = locked ? '1' : '0';
      btn.dataset.visible = visible ? '1' : '0';
      btn.title = locked
        ? '桌面歌词：已锁定（鼠标穿透，打游戏不会误触）。点一下弹出控制条'
        : '桌面歌词：控制条已弹出（可拖动 / 切歌 / 调字号）。点一下重新锁定';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', locked ? 'true' : 'false');
    }
  };

  /** 供点击处理与自检共用：真正执行一次「弹出 / 重新锁定」。 */
  const performToggle = async (source) => {
    if (stopped) return;
    const before = locked;
    try {
      const result = await folium.rpc.call('toggle-tools');
      if (result && typeof result.locked === 'boolean') locked = result.locked;
      renderButtons();
      report(
        `${source}: ${before ? '已锁定' : '已弹出'} -> ${locked ? '已锁定' : '已弹出'}` +
        `（按钮实例 ${buttons.size} 个）`,
      );
    } catch (error) {
      report(`${source} 失败: ${error && error.message ? error.message : String(error)}`);
      folium.log.error('切换桌面歌词控制条失败', error);
    }
  };

  // -------------------------------------------------- Folia 界面内的调色板
  // 桌面歌词窗口很小、还会飘，把调色板放进去既挤又容易越界。
  // 所以调色板做成 Folia 页面里的浮层，由命令面板的「桌面歌词」命令唤出。

  const SWATCHES = ['#ffffff', '#fde047', '#fca5a5', '#86efac', '#7dd3fc', '#c4b5fd', '#fb923c', '#94a3b8'];

  let paletteRoot = null;
  let paletteTarget = 'lyric';
  let paletteColors = { lyric: '#ffffff', meta: '#ffffff' };

  const PALETTE_STYLE = `
    .dl-panel {
      position: fixed;
      z-index: 2147483000;
      bottom: 96px;
      right: 24px;
      width: 232px;
      padding: 12px;
      border-radius: 14px;
      background: rgba(24,24,27,.96);
      border: 1px solid rgba(255,255,255,.10);
      box-shadow: 0 16px 44px rgba(0,0,0,.55);
      color: #e4e4e7;
      font-family: inherit;
      font-size: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .dl-panel .dl-title { font-size: 11px; opacity: .55; letter-spacing: .04em; }
    .dl-panel .dl-row { display: flex; gap: 6px; }
    .dl-panel .dl-row button {
      all: unset;
      flex: 1 1 0;
      height: 26px;
      border-radius: 7px;
      text-align: center;
      cursor: pointer;
      background: rgba(255,255,255,.10);
      color: #d4d4d8;
      font-size: 12px;
    }
    .dl-panel .dl-row button:hover { background: rgba(255,255,255,.18); }
    .dl-panel .dl-row button.on { background: rgba(251,191,36,.85); color: #1c1917; }
    .dl-panel .dl-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 6px; }
    .dl-panel .dl-grid button {
      all: unset;
      width: 100%;
      aspect-ratio: 1 / 1;
      border-radius: 6px;
      cursor: pointer;
      border: 2px solid transparent;
      box-sizing: border-box;
    }
    .dl-panel .dl-grid button:hover { border-color: rgba(255,255,255,.55); }
    .dl-panel .dl-grid button.on { border-color: #fbbf24; }
    .dl-panel .dl-foot { display: flex; align-items: center; gap: 8px; }
    .dl-panel .dl-foot input[type=color] {
      width: 34px; height: 26px; padding: 0; border: none; border-radius: 6px;
      background: transparent; cursor: pointer;
    }
    .dl-panel .dl-foot span { opacity: .55; }
    .dl-panel .dl-close {
      all: unset; margin-left: auto; cursor: pointer; opacity: .6; padding: 2px 6px;
    }
    .dl-panel .dl-close:hover { opacity: 1; }
  `;

  const sendColor = (target, hex) => {
    paletteColors = { ...paletteColors, [target]: hex };
    paintPalette();
    try {
      const pending = folium.rpc.call('set-color', target, hex);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (error) {
      report(`设置颜色失败: ${error && error.message ? error.message : String(error)}`);
    }
    report(`调色板: ${target === 'meta' ? '作者名' : '歌词'} -> ${hex}`);
  };

  const paintPalette = () => {
    if (!paletteRoot) return;
    const grid = paletteRoot.querySelector('.dl-grid');
    const current = (paletteColors[paletteTarget] || '#ffffff').toLowerCase();
    grid.replaceChildren();
    for (const hex of SWATCHES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.background = hex;
      b.title = hex;
      if (hex === current) b.classList.add('on');
      b.addEventListener('click', () => sendColor(paletteTarget, hex));
      grid.appendChild(b);
    }
    for (const btn of paletteRoot.querySelectorAll('.dl-row button')) {
      btn.classList.toggle('on', btn.dataset.target === paletteTarget);
    }
    const picker = paletteRoot.querySelector('input[type=color]');
    if (picker && picker.value.toLowerCase() !== current) picker.value = current;
  };

  const closePalette = () => {
    if (paletteRoot && paletteRoot.parentNode) paletteRoot.parentNode.removeChild(paletteRoot);
    paletteRoot = null;
  };

  const openPalette = () => {
    if (paletteRoot) { closePalette(); return; }
    const style = document.createElement('style');
    style.textContent = PALETTE_STYLE;

    const panel = document.createElement('div');
    panel.className = 'dl-panel';

    const title = document.createElement('div');
    title.className = 'dl-title';
    title.textContent = '桌面歌词 · 文字颜色';

    const row = document.createElement('div');
    row.className = 'dl-row';
    for (const [target, label] of [['lyric', '歌词'], ['meta', '作者名']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.target = target;
      b.textContent = label;
      b.addEventListener('click', () => { paletteTarget = target; paintPalette(); });
      row.appendChild(b);
    }

    const grid = document.createElement('div');
    grid.className = 'dl-grid';

    const foot = document.createElement('div');
    foot.className = 'dl-foot';
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.title = '自定义颜色';
    picker.addEventListener('input', () => sendColor(paletteTarget, picker.value));
    const hint = document.createElement('span');
    hint.textContent = '更多颜色';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'dl-close';
    close.textContent = '✕';
    close.title = '关闭';
    close.addEventListener('click', closePalette);
    foot.append(picker, hint, close);

    panel.append(title, row, grid, foot);
    document.body.append(style, panel);
    paletteRoot = panel;
    paintPalette();
    report('调色板已打开（Folia 界面）');
  };


  const onButtonClick = async (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    const now = Date.now();
    if (now - lastClickAt < 400) {
      report(`忽略过快点击（距上次 ${now - lastClickAt}ms）`);
      return;
    }
    lastClickAt = now;
    await performToggle('Folia 按键');
  };

  const mountButton = (container) => {
    const style = document.createElement('style');
    style.textContent = BUTTON_STYLE;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dl-btn';
    btn.addEventListener('click', onButtonClick);
    btn.addEventListener('pointerdown', (event) => event.stopPropagation());

    container.replaceChildren(style, btn);
    buttons.add(btn);
    renderButtons();
    report(`按键已挂载（当前共 ${buttons.size} 个，锁定=${locked}）`);

    return () => {
      btn.removeEventListener('click', onButtonClick);
      buttons.delete(btn);
      report(`按键已卸载（剩余 ${buttons.size} 个）`);
    };
  };

  let registration = null;
  try {
    registration = folium.registries.controlButtons.register({
      id: 'lyric-bar',
      slot: 'progress.leading',
      order: 10,
      hideWhenCollapsed: false,
      mount: mountButton,
    });
    folium.log.info('已在 Folia 界面注册桌面歌词按键');
  } catch (error) {
    folium.log.error('注册界面按键失败', error);
    report(`注册界面按键失败: ${error && error.message ? error.message : String(error)}`);
  }

  // ------------------------------------------------------ 命令面板里的入口
  // 常驻按钮会一直占着播放条，所以改成命令面板里的一条命令：
  // 平时不占地方，需要改颜色时按 Ctrl+K（或 Folia 的快捷键）搜「桌面歌词」即可。

  let commandRegistration = null;
  try {
    commandRegistration = folium.registries.commands.register({
      id: 'desktop-lyric-palette',
      label: {
        'zh-CN': '桌面歌词：文字颜色',
        en: 'Desktop lyric: text color',
      },
      description: {
        'zh-CN': '改桌面歌词和作者名的颜色',
        en: 'Change the color of the desktop lyric and the artist name',
      },
      keywords: ['歌词', '颜色', '调色', '桌面歌词', 'lyric', 'color', 'palette'],
      run: async () => {
        openPalette();
        return true;
      },
    });
    folium.log.info('已在命令面板注册「桌面歌词：文字颜色」');
    report('命令面板命令已注册');
  } catch (error) {
    folium.log.error('注册命令面板命令失败', error);
    report(`注册命令面板命令失败: ${error && error.message ? error.message : String(error)}`);
  }

  // ------------------------------------------------------------ 轮询

  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      const result = await folium.rpc.call('poll-commands');
      const commands = Array.isArray(result)
        ? result
        : (result && Array.isArray(result.commands) ? result.commands : []);

      for (const command of commands) {
        try {
          await run(command);
        } catch (error) {
          folium.log.error(`执行 ${command} 失败`, error);
        }
      }

      if (result && !Array.isArray(result)) {
        const nextLocked = typeof result.locked === 'boolean' ? result.locked : locked;
        const nextVisible = typeof result.visible === 'boolean' ? result.visible : visible;
        if (nextLocked !== locked || nextVisible !== visible) {
          const changed = nextLocked !== locked
            ? `锁定 ${locked ? '已锁定' : '已弹出'} -> ${nextLocked ? '已锁定' : '已弹出'}`
            : `显示 ${visible} -> ${nextVisible}`;
          locked = nextLocked;
          visible = nextVisible;
          renderButtons();
          report(`状态同步: ${changed}（按钮实例 ${buttons.size} 个）`);
        } else {
          // 自愈：宿主重挂载过按钮、或图标因故没跟上时，纠正回来。
          for (const btn of buttons) {
            const want = locked ? '1' : '0';
            if (btn.dataset.locked !== want || !btn.firstChild) {
              renderButtons();
              report(`自愈重绘按钮（locked=${locked}）`);
              break;
            }
          }
        }
      }
    } catch (error) {
      folium.log.error('轮询桌面歌词状态失败', error);
    } finally {
      polling = false;
    }
  };

  const timer = window.setInterval(() => { void poll(); }, 250);
  void poll();

  try {
    const ready = folium.rpc.call('client-ready', {
      context: folium.env?.context ?? 'unknown',
      folia: folium.host?.folia ?? null,
    });
    // 拿主进程当前颜色，调色板打开时先高亮已选的颜色
    if (ready && typeof ready.then === 'function') {
      ready.then((info) => {
        if (info && info.colors && typeof info.colors === 'object') {
          paletteColors = {
            lyric: info.colors.lyric || '#ffffff',
            meta: info.colors.meta || '#ffffff',
          };
        }
      }).catch(() => {});
    }
  } catch (error) {
    folium.log.error('上报 client 就绪失败', error);
  }

  folium.log.info('桌面歌词 client 入口已加载，切歌能力可用');
  report(`client 入口已加载（context=${folium.env?.context ?? 'unknown'}）`);

  return () => {
    stopped = true;
    window.clearInterval(timer);
    closePalette();
    try { registration?.unregister?.(); } catch { /* ignore */ }
    registration = null;
    try { commandRegistration?.unregister?.(); } catch { /* ignore */ }
    commandRegistration = null;
    buttons.clear();
  };
}
