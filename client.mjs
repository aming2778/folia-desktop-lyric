/**
 * 桌面歌词 —— Folium mod 客户端入口（渲染层，context = 'main'）
 *
 * 职责：
 *  1. 拥有 folium.playback 能力，执行歌词窗口排队的播放控制命令（切歌 / 播放暂停）。
 *  2. 在 Folia 的播放进度条上注册一个功能按键：
 *     点一下就把桌面歌词的控制条「弹出来」（解除锁定，可拖动、可点按钮）。
 *
 * 边界：客户端入口只碰 Folia 通过注册表交给自己的容器（mount 的 container），
 * 不往宿主 document.body 上挂任何东西，也不读写宿主的 localStorage。
 * 颜色这类设置通过 folium.storage 存，由主入口渲染在歌词窗口里。
 *
 * 设计要点：
 *  - 宿主可能挂载多个按钮实例，也可能重挂载；所以用 Set 保存全部实例，
 *    每个实例的清理函数只移除自己，绝不会把别的实例引用清空。
 *  - 点击加 400ms 防抖：避免双击被当成两次切换（两次 toggle 净零，看起来像没反应）。
 *  - 图标用内联 SVG（闭锁 / 开锁），不依赖 emoji 字体，状态一眼可辨。
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
    registration = folium.registries.progressButtons.register({
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

  // ------------------------------------------------- 把颜色推给桌面歌词窗口
  // 调色板已经挪进歌词窗口（见 lyric.html），这里只负责把窗口存下的颜色
  // 通过 rpc 交给主入口去应用，客户端入口不再自己画任何界面。

  const applySavedColors = (saved) => {
    if (!saved || typeof saved !== 'object') return;
    for (const target of ['lyric', 'meta']) {
      const hex = String(saved[target] || '');
      if (!/^#[0-9a-f]{6}$/i.test(hex)) continue;
      try {
        const pending = folium.rpc.call('set-color', target, hex);
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch (error) {
        report(`应用颜色失败: ${error && error.message ? error.message : String(error)}`);
      }
    }
  };

  const syncColors = async () => {
    try {
      const saved = await folium.storage.data.get('colors');
      applySavedColors(saved);
    } catch (error) {
      folium.log.error('读取桌面歌词颜色失败', error);
    }
  };

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

  void syncColors();

  try {
    folium.rpc.call('client-ready', {
      context: folium.env?.context ?? 'unknown',
      folia: folium.host?.folia ?? null,
    });
  } catch (error) {
    folium.log.error('上报 client 就绪失败', error);
  }

  folium.log.info('桌面歌词 client 入口已加载，切歌能力可用');
  report(`client 入口已加载（context=${folium.env?.context ?? 'unknown'}）`);

  return () => {
    stopped = true;
    window.clearInterval(timer);
    try { registration?.unregister?.(); } catch { /* ignore */ }
    registration = null;
    buttons.clear();
  };
}
