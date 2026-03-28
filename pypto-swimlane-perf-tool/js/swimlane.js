/**
 * swimlane.js - 泳道图渲染模块
 *
 * 架构：原生滚动模式
 *   canvas 宽度 = duration × xScale（执行总时长对应的像素宽度）
 *   水平位置 = viewport.scrollLeft，由浏览器原生控制
 *   → 时间轴长度天然等于执行总时长，不可能超出
 *   → 滚轮仅缩放时间粒度，拖拽改变水平位置
 */

'use strict';

const SWIMLANE_CONFIG = {
  ROW_HEIGHT: 22,
  ROW_PADDING: 3,
  LABEL_WIDTH: 120,
  TIME_AXIS_HEIGHT: 30,
  MIN_TASK_WIDTH: 1,
  ZOOM_FACTOR: 1.25,
  BG_COLOR: '#0F172A',
  LABEL_BG: '#1E293B',
  LABEL_TEXT: '#94A3B8',
  AXIS_COLOR: '#334155',
  TICK_COLOR: '#64748B',
  GRID_COLOR: '#1E293B',
  BUBBLE_COLOR: 'rgba(239, 68, 68, 0.15)',
  SELECTED_ROW_BG: 'rgba(59, 130, 246, 0.08)',
  BOTTLENECK_ROW_BG: 'rgba(239, 68, 68, 0.12)',
};

// 分组颜色板（背景填充 / 边框描边 / 标签文字）
const GROUP_PALETTE = [
  { bg: 'rgba(59,130,246,0.06)',  border: 'rgba(59,130,246,0.55)',  text: '#60A5FA' },
  { bg: 'rgba(16,185,129,0.06)', border: 'rgba(16,185,129,0.55)', text: '#34D399' },
  { bg: 'rgba(245,158,11,0.06)', border: 'rgba(245,158,11,0.55)', text: '#FCD34D' },
  { bg: 'rgba(239,68,68,0.06)',  border: 'rgba(239,68,68,0.55)',  text: '#FCA5A5' },
  { bg: 'rgba(139,92,246,0.06)', border: 'rgba(139,92,246,0.55)', text: '#C4B5FD' },
  { bg: 'rgba(236,72,153,0.06)', border: 'rgba(236,72,153,0.55)', text: '#F9A8D4' },
  { bg: 'rgba(34,211,238,0.06)', border: 'rgba(34,211,238,0.55)', text: '#67E8F9' },
  { bg: 'rgba(251,146,60,0.06)', border: 'rgba(251,146,60,0.55)', text: '#FDBA74' },
];

class SwimlaneRenderer {
  constructor(container, labelContainer) {
    this.container = container;       // #swimlaneCanvas div
    this.labelContainer = labelContainer; // #swimlaneLabel div
    this.canvas = null;
    this.labelCanvas = null;
    this.ctx = null;
    this.labelCtx = null;

    // 数据
    this.parsedData = null;
    this.analysisResult = null;
    this.sortedCores = [];
    this.visibleCores = new Set();
    this.bottleneckCores = new Set();

    // 缩放状态（水平位置由 viewport.scrollLeft 管理）
    this.xScale = 1;        // px / μs

    // 悬停 / 选中
    this.hoveredCore = null;
    this.hoveredEvent = null;
    this.selectedCore = null;
    this.selectedEvent = null;
    this.relatedEvents = [];

    // 垂直滚动位置（用于时间轴 sticky 效果）
    this.yScrollTop = 0;

    // 拖拽平移
    this.isDragging = false;
    this.dragStartClientX = 0;
    this.dragStartScrollLeft = 0;

    // 过滤
    this.showAIC = true;
    this.showAIV = true;
    this.showBubbles = true;
    this.highlightBottlenecks = true;
    this.showGroups = true;

    // 分组数据
    this.groupBands = [];

    // 外部回调
    this.onCoreClick = null;
    this.onEventClick = null;
    this.onOpenComputeGraph = null;

    this._setupCanvases();
    this._bindEvents();
  }

  // ─── 内部 DOM 辅助 ────────────────────────────────────────────
  _viewport() {
    // swimlane-inner → swimlane-viewport
    return this.container.parentElement?.parentElement ?? null;
  }

  _getScrollLeft() {
    return this._viewport()?.scrollLeft ?? 0;
  }

  _getViewportW() {
    const vp = this._viewport();
    return vp ? vp.clientWidth - SWIMLANE_CONFIG.LABEL_WIDTH - 2 : 800;
  }

  _getViewportH() {
    return this._viewport()?.clientHeight ?? 400;
  }

  /** canvas 绘制宽度 = 执行总时长对应像素数 */
  _getDataWidth() {
    if (!this.parsedData) return 800;
    return Math.ceil(this.parsedData.timeRange.duration * this.xScale);
  }

  // ─── 初始化 ───────────────────────────────────────────────────
  _setupCanvases() {
    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.style.display = 'block';
    this.labelCanvas.style.cursor = 'default';
    this.labelCtx = this.labelCanvas.getContext('2d');
    this.labelContainer.appendChild(this.labelCanvas);

    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.cursor = 'grab';
    this.ctx = this.canvas.getContext('2d');
    this.container.appendChild(this.canvas);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'swimlane-tooltip';
    this.tooltip.style.display = 'none';
    document.body.appendChild(this.tooltip);

    // 监听视口滚动（包含水平 scrollLeft 变化）→ 重绘
    const vp = this._viewport();
    if (vp) {
      vp.addEventListener('scroll', () => {
        this.yScrollTop = vp.scrollTop;
        this._render();
        this._renderLabels();
      }, { passive: true });
    }
  }

  _bindEvents() {
    // ── 标签区滚轮：仅纵向滚动 ──────────────────────────────────
    this.labelContainer.addEventListener('wheel', (e) => {
      e.preventDefault();
      const vp = this._viewport();
      if (vp) vp.scrollTop += e.deltaY * 0.8;
    }, { passive: false });

    // ── 主 canvas 滚轮：仅缩放时间粒度 ─────────────────────────
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      // mouseViewportX：鼠标在「泳道可视区」内的 X 位置（不含标签列）
      const mouseViewportX = e.clientX - rect.left;
      const factor = e.deltaY < 0 ? SWIMLANE_CONFIG.ZOOM_FACTOR : 1 / SWIMLANE_CONFIG.ZOOM_FACTOR;
      this._zoom(factor, mouseViewportX);
    }, { passive: false });

    // ── 拖拽平移（改变 scrollLeft）────────────────────────────
    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.dragStartClientX = e.clientX;
      this.dragStartScrollLeft = this._getScrollLeft();
      this.canvas.style.cursor = 'grabbing';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDragging) {
        const dx = e.clientX - this.dragStartClientX;
        const vp = this._viewport();
        if (vp) vp.scrollLeft = this.dragStartScrollLeft - dx;
        return;
      }
      this._handleMouseMove(e);
    });

    window.addEventListener('mouseup', () => {
      if (this.isDragging) {
        this.isDragging = false;
        this.canvas.style.cursor = 'grab';
      }
    });

    // ── 点击事件 ─────────────────────────────────────────────
    this.canvas.addEventListener('click', (e) => {
      const { coreIndex, event } = this._hitTest(e);

      if (event) {
        this.selectedEvent = (this.selectedEvent === event) ? null : event;
        this.relatedEvents = this.selectedEvent ? this._getRelatedEvents(this.selectedEvent) : [];
        if (this.onEventClick) this.onEventClick(this.selectedEvent, this.relatedEvents);
        this._render();
        this._renderLabels();
        return;
      }

      if (coreIndex >= 0) {
        const coreName = this._getVisibleCores()[coreIndex];
        this.selectedCore = (this.selectedCore === coreName) ? null : coreName;
        if (this.onCoreClick) this.onCoreClick(coreName);
        this._render();
        this._renderLabels();
      }
    });
  }

  // ─── 数据加载 ─────────────────────────────────────────────────
  loadData(parsedData, analysisResult) {
    this.parsedData = parsedData;
    this.analysisResult = analysisResult;

    this.sortedCores = sortCoreNames([...parsedData.coreEvents.keys()])
      .filter(n => !n.startsWith('Fake'));
    this.visibleCores = new Set(this.sortedCores);

    this.bottleneckCores = new Set();
    analysisResult?.bottlenecks?.forEach(b =>
      b.affectedCores?.forEach(c => this.bottleneckCores.add(c))
    );

    this._initView();
    this._resize();
    this._render();
    this._renderLabels();
  }

  _initView() {
    if (!this.parsedData) return;
    const dur = this.parsedData.timeRange.duration;
    if (dur <= 0) return;
    // 初始缩放：全量数据恰好铺满可视宽度
    this.xScale = Math.max(0.001, this._getViewportW() / dur);
    // 重置水平位置
    const vp = this._viewport();
    if (vp) vp.scrollLeft = 0;
  }

  // ─── Canvas 尺寸 ──────────────────────────────────────────────
  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const visibleRows = this._getVisibleCores();
    const contentH = SWIMLANE_CONFIG.TIME_AXIS_HEIGHT + visibleRows.length * SWIMLANE_CONFIG.ROW_HEIGHT + 20;

    // 宽度 = 执行总时长对应像素（时间轴长度 = 总时长）
    const dataW = this._getDataWidth();
    const viewportW = this._getViewportW();
    const viewportH = this._getViewportH();

    const canvasW = Math.max(dataW, viewportW);
    const canvasH = Math.max(contentH, viewportH);

    this.canvas.width  = canvasW * dpr;
    this.canvas.height = canvasH * dpr;
    this.canvas.style.width  = `${canvasW}px`;
    this.canvas.style.height = `${canvasH}px`;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);

    this.labelCanvas.width  = SWIMLANE_CONFIG.LABEL_WIDTH * dpr;
    this.labelCanvas.height = canvasH * dpr;
    this.labelCanvas.style.width  = `${SWIMLANE_CONFIG.LABEL_WIDTH}px`;
    this.labelCanvas.style.height = `${canvasH}px`;
    this.labelCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.labelCtx.scale(dpr, dpr);
  }

  // ─── 缩放（以鼠标在视口中的 X 为轴心）────────────────────────
  _zoom(factor, mouseViewportX) {
    if (!this.parsedData) return;
    const dur = this.parsedData.timeRange.duration;
    if (dur <= 0) return;

    const viewportW = this._getViewportW();
    const minScale = viewportW / dur;            // 最小缩放 = 全量铺满
    const oldScale = this.xScale;
    const newScale = Math.max(minScale, Math.min(oldScale * factor, 50000));
    if (newScale === oldScale) return;

    // 锚点：鼠标对应的时间点在缩放前后不动
    const scrollLeft = this._getScrollLeft();
    const timeAtMouse = (scrollLeft + mouseViewportX) / oldScale;

    this.xScale = newScale;
    this._resize();

    // 调整 scrollLeft 使 timeAtMouse 仍在鼠标下方
    const newScrollLeft = timeAtMouse * newScale - mouseViewportX;
    const vp = this._viewport();
    if (vp) vp.scrollLeft = Math.max(0, newScrollLeft);

    this._render();
    this._renderLabels();
  }

  // ─── 主渲染 ───────────────────────────────────────────────────
  _render() {
    if (!this.parsedData) return;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const canvasW = this.canvas.width / dpr;
    const canvasH = this.canvas.height / dpr;

    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.fillStyle = SWIMLANE_CONFIG.BG_COLOR;
    ctx.fillRect(0, 0, canvasW, canvasH);

    const scrollLeft  = this._getScrollLeft();
    const viewportW   = this._getViewportW();
    const { timeRange, coreEvents, colorMap } = this.parsedData;

    // 当前可见的时间范围（用于裁剪，加速绘制）
    const viewStartTime = scrollLeft / this.xScale;
    const viewEndTime   = (scrollLeft + viewportW) / this.xScale;

    // 时间轴（随纵向滚动跟随）
    this._renderTimeAxis(ctx, canvasW, timeRange, viewStartTime, viewEndTime, this.yScrollTop);

    // 分组背景（在行和任务条之前绘制）
    this._renderGroupBandsBg(ctx, canvasW, canvasH);

    // 每一行
    this._getVisibleCores().forEach((coreName, rowIndex) => {
      const y = SWIMLANE_CONFIG.TIME_AXIS_HEIGHT + rowIndex * SWIMLANE_CONFIG.ROW_HEIGHT;
      this._renderRow(
        ctx, canvasW, coreName, rowIndex, y,
        coreEvents.get(coreName) || [],
        colorMap, timeRange, viewStartTime, viewEndTime
      );
    });

    // 关联连线
    this._renderRelations(ctx, canvasW, timeRange);

    // 分组边框和标签（在行之后绘制，保证可见性）
    this._renderGroupBandsOverlay(ctx, canvasW, canvasH);

    // 选中核心高亮边框
    if (this.selectedCore) {
      const idx = this._getVisibleCores().indexOf(this.selectedCore);
      if (idx >= 0) {
        const y = SWIMLANE_CONFIG.TIME_AXIS_HEIGHT + idx * SWIMLANE_CONFIG.ROW_HEIGHT;
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(0, y, canvasW, SWIMLANE_CONFIG.ROW_HEIGHT);
      }
    }
  }

  // ─── 时间轴 ───────────────────────────────────────────────────
  _renderTimeAxis(ctx, canvasW, timeRange, viewStartTime, viewEndTime, axisY = 0) {
    const axisH    = SWIMLANE_CONFIG.TIME_AXIS_HEIGHT;
    const duration = timeRange.duration;
    const dataW    = this._getDataWidth();
    const canvasH  = this.canvas.height / (window.devicePixelRatio || 1);

    // 背景（仅绘制数据范围 [0, dataW]）
    ctx.fillStyle = SWIMLANE_CONFIG.LABEL_BG;
    ctx.fillRect(0, axisY, dataW, axisH);

    // dataW 右侧若还有空白（视口比数据宽时），填暗色
    if (dataW < canvasW) {
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(dataW, axisY, canvasW - dataW, axisH);
      ctx.fillRect(dataW, SWIMLANE_CONFIG.TIME_AXIS_HEIGHT, canvasW - dataW, canvasH);
    }

    // 底部分割线
    ctx.strokeStyle = SWIMLANE_CONFIG.AXIS_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, axisY + axisH);
    ctx.lineTo(dataW, axisY + axisH);
    ctx.stroke();

    // 刻度（只在可见范围内生成，节省绘制开销）
    const clampedStart = Math.max(0, viewStartTime);
    const clampedEnd   = Math.min(duration, viewEndTime);
    if (clampedEnd <= clampedStart) return;

    const viewDuration = clampedEnd - clampedStart;
    const tickCount    = Math.max(4, Math.floor(this._getViewportW() / 80));
    const tickInterval = this._niceInterval(viewDuration / tickCount);
    const firstTick    = Math.ceil(clampedStart / tickInterval) * tickInterval;

    ctx.font = '10px monospace';
    ctx.textAlign = 'center';

    for (let t = firstTick; t <= clampedEnd + tickInterval * 0.01; t += tickInterval) {
      if (t < 0 || t > duration) continue;
      const x = t * this.xScale;   // 绝对 canvas 坐标
      if (x < 0 || x > dataW) continue;

      // 刻度线
      ctx.strokeStyle = SWIMLANE_CONFIG.TICK_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, axisY + axisH - 7);
      ctx.lineTo(x, axisY + axisH);
      ctx.stroke();

      // 刻度标签
      ctx.fillStyle = SWIMLANE_CONFIG.TICK_COLOR;
      ctx.fillText(this._formatTime(t), x, axisY + axisH - 9);

      // 垂直网格线
      ctx.strokeStyle = SWIMLANE_CONFIG.GRID_COLOR;
      ctx.lineWidth = 0.5;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(x, SWIMLANE_CONFIG.TIME_AXIS_HEIGHT);
      ctx.lineTo(x, canvasH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 起始边界线（t=0，x=0）
    ctx.strokeStyle = '#22D3EE';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0.5, axisY);
    ctx.lineTo(0.5, canvasH);
    ctx.stroke();
    ctx.fillStyle = '#22D3EE';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('0', 4, axisY + axisH - 9);

    // 结束边界线（t=duration，x=dataW）
    ctx.strokeStyle = '#F97316';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(dataW - 0.5, axisY);
    ctx.lineTo(dataW - 0.5, canvasH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#F97316';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${this._formatTime(duration)} ►`, dataW - 4, axisY + axisH - 9);
  }

  // ─── 行渲染 ───────────────────────────────────────────────────
  _renderRow(ctx, canvasW, coreName, rowIndex, y, events, colorMap, timeRange, viewStartTime, viewEndTime) {
    const rh      = SWIMLANE_CONFIG.ROW_HEIGHT;
    const padding = SWIMLANE_CONFIG.ROW_PADDING;
    const radius  = 2;

    const isBottleneck = this.highlightBottlenecks && this.bottleneckCores.has(coreName);
    const isSelected   = coreName === this.selectedCore;
    const isHovered    = coreName === this.hoveredCore;

    // 行背景
    if (isSelected)       ctx.fillStyle = SWIMLANE_CONFIG.SELECTED_ROW_BG;
    else if (isBottleneck) ctx.fillStyle = SWIMLANE_CONFIG.BOTTLENECK_ROW_BG;
    else if (isHovered)    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    else                   ctx.fillStyle = rowIndex % 2 === 0 ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0.02)';
    ctx.fillRect(0, y, canvasW, rh);

    // 行分割线
    ctx.strokeStyle = SWIMLANE_CONFIG.AXIS_COLOR;
    ctx.lineWidth = 0.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, y + rh);
    ctx.lineTo(canvasW, y + rh);
    ctx.stroke();

    // 任务条
    for (const event of events) {
      const relStart = event.ts - timeRange.start;
      const relEnd   = relStart + (event.dur || 0);
      if (relEnd < viewStartTime || relStart > viewEndTime) continue;

      // 绝对 canvas 坐标
      const x  = relStart * this.xScale;
      const x2 = relEnd   * this.xScale;
      const w  = Math.max(SWIMLANE_CONFIG.MIN_TASK_WIDTH, x2 - x);

      const op    = getEventOpType(event);
      const color = colorMap[op] || '#64748B';

      const isHovEvent    = event === this.hoveredEvent;
      const isSelEvent    = event === this.selectedEvent;
      const isRelated     = this.relatedEvents.includes(event);

      ctx.beginPath();
      ctx.roundRect(x, y + padding, w, rh - padding * 2, radius);

      if (isSelEvent) {
        ctx.fillStyle = this._lightenColor(color, 60);
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (isRelated) {
        ctx.fillStyle = this._lightenColor(color, 40);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.fillStyle = isHovEvent ? this._lightenColor(color, 40) : color;
        ctx.fill();
      }

      if (w > 30) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x + 2, y + padding, w - 4, rh - padding * 2, radius);
        ctx.clip();
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        const lbl = op.length > 12 ? op.substring(0, 11) + '…' : op;
        ctx.fillText(lbl, x + 2, y + rh - padding - 3);
        ctx.restore();
      }
    }

    // 气泡（任务间空隙）
    if (this.showBubbles) {
      const gaps = this.analysisResult?.coreMetrics?.get(coreName)?.gaps;
      if (gaps) {
        for (const gap of gaps) {
          if (gap.duration < 0.5) continue;
          const relStart = gap.start - timeRange.start;
          const relEnd   = gap.end   - timeRange.start;
          if (relEnd < viewStartTime || relStart > viewEndTime) continue;
          const gx = relStart * this.xScale;
          const gw = Math.max(0.5, relEnd * this.xScale - gx);
          ctx.fillStyle = SWIMLANE_CONFIG.BUBBLE_COLOR;
          ctx.fillRect(gx, y + padding, gw, rh - padding * 2);
        }
      }
    }
  }

  // ─── 关联连线 ────────────────────────────────────────────────
  _renderRelations(ctx, canvasW, timeRange) {
    if (!this.selectedEvent || this.relatedEvents.length === 0) return;
    const cur = this._getEventPos(this.selectedEvent);
    if (!cur) return;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);

    for (const rel of this.relatedEvents) {
      const rp = this._getEventPos(rel);
      if (!rp) continue;
      const fwd  = this.selectedEvent.ts <= rel.ts;
      const src  = fwd ? cur : rp;
      const dst  = fwd ? rp  : cur;
      const sx   = src.x + src.w, sy = src.y + src.h / 2;
      const dx   = dst.x,         dy = dst.y + dst.h / 2;
      const cpx  = (sx + dx) / 2;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.bezierCurveTo(cpx, sy, cpx, dy, dx, dy);
      ctx.stroke();
      this._drawArrow(ctx, dx - 5, dy, dx, dy);
    }
    ctx.restore();
  }

  // ─── 分组区间渲染 ─────────────────────────────────────────────

  setGroupBands(bands) {
    this.groupBands = bands || [];
    this._render();
  }

  toggleGroups(show) {
    this.showGroups = show;
    this._render();
  }

  /**
   * 第一遍：仅绘制背景填充色（在任务条之前，不遮挡任务）
   */
  _renderGroupBandsBg(ctx, canvasW, canvasH) {
    if (!this.showGroups || !this.groupBands.length) return;

    const axisH = SWIMLANE_CONFIG.TIME_AXIS_HEIGHT;

    ctx.save();
    this.groupBands.forEach((band, idx) => {
      const x1 = band.start * this.xScale;
      const x2 = band.end   * this.xScale;
      if (x2 <= 0 || x1 >= canvasW) return;

      const { bg } = GROUP_PALETTE[idx % GROUP_PALETTE.length];
      ctx.fillStyle = bg;
      ctx.fillRect(x1, axisH, x2 - x1, canvasH - axisH);
    });
    ctx.restore();
  }

  /**
   * 第二遍：绘制边框 + 顶部标签（在任务条之后，保证可见）
   */
  _renderGroupBandsOverlay(ctx, canvasW, canvasH) {
    if (!this.showGroups || !this.groupBands.length) return;

    const axisH    = SWIMLANE_CONFIG.TIME_AXIS_HEIGHT;
    const scrollLeft = this._getScrollLeft();
    const labelH   = 13;   // 标签背景高度
    const labelY   = axisH + 3;

    ctx.save();
    ctx.font = 'bold 10px monospace';

    this.groupBands.forEach((band, idx) => {
      const x1 = band.start * this.xScale;
      const x2 = band.end   * this.xScale;
      if (x2 <= 0 || x1 >= canvasW) return;

      const { border, text } = GROUP_PALETTE[idx % GROUP_PALETTE.length];
      const bandW = x2 - x1;

      // 左边框
      ctx.strokeStyle = border;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x1, axisH);
      ctx.lineTo(x1, canvasH);
      ctx.stroke();

      // 右边框
      ctx.beginPath();
      ctx.moveTo(x2, axisH);
      ctx.lineTo(x2, canvasH);
      ctx.stroke();

      // 顶部横线（紧贴时间轴下方）
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1, axisH);
      ctx.lineTo(x2, axisH);
      ctx.stroke();

      // 标签：粘附在可视区左边缘，但不超出分组右边界
      const labelText  = `G${band.id}`;
      const textW      = ctx.measureText(labelText).width + 8;

      // 标签 X 位置：分组开始处，若分组已滚出左侧则贴左视口边缘
      let lx = Math.max(x1 + 4, scrollLeft + 4);
      // 不超出分组右侧（留出文字宽度）
      lx = Math.min(lx, x2 - textW - 2);

      if (lx + textW > x1 && bandW > 8) {
        // 标签背景
        ctx.fillStyle = border.replace(/[\d.]+\)$/, '0.85)'); // 更高不透明度
        ctx.beginPath();
        ctx.roundRect(lx - 2, labelY, textW, labelH, 3);
        ctx.fill();

        // 标签文字
        ctx.fillStyle = text;
        ctx.textAlign  = 'left';
        ctx.fillText(labelText, lx + 2, labelY + 10);
      }
    });

    ctx.setLineDash([]);
    ctx.restore();
  }

  _getEventPos(event) {
    if (!this.parsedData) return null;
    const coreName   = this.parsedData.threadMap.get(event.tid) || `Core_${event.tid}`;
    const visibleCores = this._getVisibleCores();
    const rowIndex   = visibleCores.indexOf(coreName);
    if (rowIndex < 0) return null;
    const y = SWIMLANE_CONFIG.TIME_AXIS_HEIGHT + rowIndex * SWIMLANE_CONFIG.ROW_HEIGHT;
    const x = (event.ts - this.parsedData.timeRange.start) * this.xScale;
    return { x, y, w: (event.dur || 0) * this.xScale, h: SWIMLANE_CONFIG.ROW_HEIGHT };
  }

  _drawArrow(ctx, fx, fy, tx, ty) {
    const len = 8, angle = Math.atan2(ty - fy, tx - fx);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - len * Math.cos(angle - Math.PI / 6), ty - len * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - len * Math.cos(angle + Math.PI / 6), ty - len * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  }

  // ─── 标签列渲染 ───────────────────────────────────────────────
  _renderLabels() {
    if (!this.parsedData) return;
    const ctx = this.labelCtx;
    const W   = SWIMLANE_CONFIG.LABEL_WIDTH;
    const H   = this.labelCanvas.height / (window.devicePixelRatio || 1);

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = SWIMLANE_CONFIG.LABEL_BG;
    ctx.fillRect(0, 0, W, H);

    // 时间轴标题区（跟随纵向滚动）
    const axisY = this.yScrollTop;
    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, axisY, W, SWIMLANE_CONFIG.TIME_AXIS_HEIGHT);
    ctx.fillStyle = '#94A3B8';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('核心', W / 2, axisY + SWIMLANE_CONFIG.TIME_AXIS_HEIGHT / 2 + 4);

    ctx.strokeStyle = SWIMLANE_CONFIG.AXIS_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, axisY + SWIMLANE_CONFIG.TIME_AXIS_HEIGHT);
    ctx.lineTo(W, axisY + SWIMLANE_CONFIG.TIME_AXIS_HEIGHT);
    ctx.stroke();

    const visibleCores = this._getVisibleCores();
    visibleCores.forEach((coreName, i) => {
      const y  = SWIMLANE_CONFIG.TIME_AXIS_HEIGHT + i * SWIMLANE_CONFIG.ROW_HEIGHT;
      const rh = SWIMLANE_CONFIG.ROW_HEIGHT;

      const isBottleneck = this.highlightBottlenecks && this.bottleneckCores.has(coreName);
      const isSelected   = coreName === this.selectedCore;
      const isHovered    = coreName === this.hoveredCore;

      if (isSelected)       ctx.fillStyle = 'rgba(59,130,246,0.2)';
      else if (isBottleneck) ctx.fillStyle = 'rgba(239,68,68,0.15)';
      else if (isHovered)    ctx.fillStyle = 'rgba(255,255,255,0.05)';
      else                   ctx.fillStyle = i % 2 === 0 ? SWIMLANE_CONFIG.LABEL_BG : 'rgba(255,255,255,0.02)';
      ctx.fillRect(0, y, W, rh);

      // 类型色条
      const coreType  = getCoreType(coreName);
      const typeColor = coreType === 'AIC' ? '#3B82F6' : coreType === 'AIV' ? '#10B981' : '#94A3B8';
      ctx.fillStyle = typeColor;
      ctx.fillRect(0, y + 3, 3, rh - 6);

      // 利用率底色
      const metrics = this.analysisResult?.coreMetrics?.get(coreName);
      if (metrics) {
        ctx.fillStyle = getRatingColor(metrics.utilization, 'utilization') + '33';
        ctx.fillRect(3, y + 3, W - 6, rh - 6);
      }

      // 核心名称
      ctx.fillStyle = isSelected ? '#E2E8F0' : SWIMLANE_CONFIG.LABEL_TEXT;
      ctx.font = isSelected ? 'bold 11px monospace' : '11px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(coreName, 8, y + rh / 2 + 4);

      // 瓶颈图标
      if (isBottleneck) {
        ctx.fillStyle = '#EF4444';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('⚠', W - 4, y + rh / 2 + 4);
      }

      // 行分割线
      ctx.strokeStyle = SWIMLANE_CONFIG.AXIS_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y + rh);
      ctx.lineTo(W, y + rh);
      ctx.stroke();
    });

    // 右侧边框
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(W - 1, 0);
    ctx.lineTo(W - 1, H);
    ctx.stroke();
  }

  // ─── 鼠标交互 ─────────────────────────────────────────────────
  _handleMouseMove(e) {
    const { coreIndex, event } = this._hitTest(e);
    const visibleCores    = this._getVisibleCores();
    const newCore  = coreIndex >= 0 ? visibleCores[coreIndex] : null;
    const changed  = newCore !== this.hoveredCore || event !== this.hoveredEvent;

    this.hoveredCore  = newCore;
    this.hoveredEvent = event;

    if (changed) { this._render(); this._renderLabels(); }
    if (event && newCore) this._showTooltip(e, event, newCore);
    else this._hideTooltip();
  }

  _hitTest(e) {
    const rect    = this.canvas.getBoundingClientRect();
    const mouseX  = e.clientX - rect.left;  // 相对 canvas 的 x（含 scrollLeft 偏移）
    const mouseY  = e.clientY - rect.top;

    const rowIndex = Math.floor((mouseY - SWIMLANE_CONFIG.TIME_AXIS_HEIGHT) / SWIMLANE_CONFIG.ROW_HEIGHT);
    const visibleCores = this._getVisibleCores();
    if (rowIndex < 0 || rowIndex >= visibleCores.length) return { coreIndex: -1, event: null };

    const coreName  = visibleCores[rowIndex];
    const events    = this.parsedData?.coreEvents.get(coreName) || [];
    const timeRange = this.parsedData?.timeRange;

    // mouseX 已经是绝对 canvas 坐标（getBoundingClientRect 随 scrollLeft 变化）
    const timeAtMouse = mouseX / this.xScale;

    let hitEvent = null;
    for (const ev of events) {
      const relStart = ev.ts - timeRange.start;
      const relEnd   = relStart + (ev.dur || 0);
      if (timeAtMouse >= relStart - 0.5 && timeAtMouse <= relEnd + 0.5) { hitEvent = ev; break; }
    }

    return { coreIndex: rowIndex, event: hitEvent };
  }

  _showTooltip(e, event, coreName) {
    const op       = getEventOpType(event);
    const execHint = parseExecutionHint(event.args?.['execution-hint']);
    const taskId   = event.args?.taskId || event.args?.TaskId || '';

    let html = `
      <div class="tt-header">
        <span class="tt-core">${coreName}</span>
        <span class="tt-op">${op}</span>
      </div>
      <div class="tt-body">
        <div class="tt-row"><span>任务名称</span><span>${event.name || '-'}</span></div>
        <div class="tt-row"><span>持续时间</span><span>${(event.dur || 0).toFixed(3)} μs</span></div>
        <div class="tt-row"><span>任务 ID</span><span>${taskId}</span></div>`;
    if (execHint?.avg) html += `<div class="tt-row"><span>平均时间</span><span>${execHint.avg.toFixed(3)} μs</span></div>`;
    if (execHint?.max) html += `<div class="tt-row"><span>最大时间</span><span>${execHint.max.toFixed(3)} μs</span></div>`;
    if (execHint?.min) html += `<div class="tt-row"><span>最小时间</span><span>${execHint.min.toFixed(3)} μs</span></div>`;

    const hint = event.args?.['event-hint'];
    if (hint) {
      const m = hint.match(/Task:\[([^\]]+)\]/);
      if (m) html += `<div class="tt-row"><span>Task</span><span>[${m[1]}]</span></div>`;
    }
    html += '</div>';

    this.tooltip.innerHTML = html;
    this.tooltip.style.display = 'block';

    const tx = e.clientX + 12, ty = e.clientY - 10;
    const ttH = this.tooltip.offsetHeight;
    this.tooltip.style.left = `${Math.min(tx, window.innerWidth - 270)}px`;
    this.tooltip.style.top  = `${Math.max(5, ty + ttH > window.innerHeight ? ty - ttH - 20 : ty)}px`;
  }

  _hideTooltip() { this.tooltip.style.display = 'none'; }

  // ─── 公共 API ─────────────────────────────────────────────────
  setFilter(showAIC, showAIV) {
    this.showAIC = showAIC;
    this.showAIV = showAIV;
    this._resize();
    this._render();
    this._renderLabels();
  }

  toggleBubbles(show)            { this.showBubbles = show; this._render(); }
  toggleBottleneckHighlight(show){ this.highlightBottlenecks = show; this._render(); this._renderLabels(); }

  scrollToCore(coreName) {
    const idx = this._getVisibleCores().indexOf(coreName);
    if (idx < 0) return;
    this.selectedCore = coreName;

    const y  = SWIMLANE_CONFIG.TIME_AXIS_HEIGHT + idx * SWIMLANE_CONFIG.ROW_HEIGHT;
    const vp = this._viewport();
    if (vp) vp.scrollTop = Math.max(0, y - vp.clientHeight / 2);

    this._render();
    this._renderLabels();
  }

  fitToView() {
    this._initView();
    this._resize();
    this._render();
    this._renderLabels();
  }

  exportPNG() {
    const a = document.createElement('a');
    a.download = 'swimlane_export.png';
    a.href = this.canvas.toDataURL('image/png');
    a.click();
  }

  onResize() {
    this._resize();
    this._render();
    this._renderLabels();
  }

  // ─── 工具 ─────────────────────────────────────────────────────
  _getVisibleCores() {
    return this.sortedCores.filter(n => {
      if (!this.visibleCores.has(n)) return false;
      const t = getCoreType(n);
      if (t === 'AIC' && !this.showAIC) return false;
      if (t === 'AIV' && !this.showAIV) return false;
      return true;
    });
  }

  _getRelatedEvents(event) {
    if (!event || !this.parsedData?.relations) return [];
    return Array.from(this.parsedData.relations.get(event) ?? []);
  }

  _niceInterval(raw) {
    const steps = [0.1,0.2,0.5,1,2,5,10,20,50,100,200,500,1000,2000,5000,10000];
    return steps.find(s => s >= raw) ?? raw;
  }

  _formatTime(us) {
    if (us >= 1000) return `${(us/1000).toFixed(1)}ms`;
    if (us >= 1)    return `${us.toFixed(0)}μs`;
    return `${us.toFixed(2)}μs`;
  }

  _lightenColor(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.min(255, (n >> 16)        + amt);
    const g = Math.min(255, ((n >> 8) & 0xff) + amt);
    const b = Math.min(255, (n & 0xff)        + amt);
    return `rgb(${r},${g},${b})`;
  }
}
