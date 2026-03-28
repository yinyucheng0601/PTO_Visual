/**
 * swimlane.js - 泳道图渲染模块
 * 基于 Canvas API 实现高性能泳道图渲染，支持缩放、平移、悬停提示
 */

'use strict';

const SWIMLANE_CONFIG = {
  ROW_HEIGHT: 22,          // 每行高度 (px)
  ROW_PADDING: 3,          // 行内上下边距
  LABEL_WIDTH: 120,        // 左侧标签宽度
  TIME_AXIS_HEIGHT: 30,    // 时间轴高度
  MIN_TASK_WIDTH: 1,       // 最小任务宽度 (px)
  ZOOM_FACTOR: 1.2,        // 每次缩放倍数
  BG_COLOR: '#0F172A',     // 背景色
  LABEL_BG: '#1E293B',     // 标签区背景
  LABEL_TEXT: '#94A3B8',   // 标签文字颜色
  AXIS_COLOR: '#334155',   // 时间轴颜色
  TICK_COLOR: '#64748B',   // 刻度颜色
  GRID_COLOR: '#1E293B',   // 网格线颜色
  BUBBLE_COLOR: 'rgba(239, 68, 68, 0.15)', // 气泡/空隙高亮
  SELECTED_ROW_BG: 'rgba(59, 130, 246, 0.08)', // 选中行背景
  BOTTLENECK_ROW_BG: 'rgba(239, 68, 68, 0.12)', // 瓶颈行背景
};

class SwimlaneRenderer {
  constructor(container, labelContainer) {
    this.container = container;
    this.labelContainer = labelContainer;
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

    // 视图状态
    this.xScale = 1;        // 像素/微秒
    this.xOffset = 0;       // 当前水平偏移 (px)
    this.yScrollOffset = 0; // 垂直滚动偏移 (px, 旧)
    this.yScrollTop = 0;    // 视口当前滚动位置
    this.hoveredCore = null;
    this.hoveredEvent = null;
    this.selectedCore = null;

    // 交互状态
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartOffset = 0;

    // 过滤状态
    this.showAIC = true;
    this.showAIV = true;
    this.showBubbles = true;
    this.highlightBottlenecks = true;

    // 回调
    this.onCoreClick = null;
    this.onEventClick = null;

    this._setupCanvases();
    this._bindEvents();
  }

  _setupCanvases() {
    // 标签 canvas (固定左侧)
    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.style.display = 'block';
    this.labelCanvas.style.cursor = 'default';
    this.labelCtx = this.labelCanvas.getContext('2d');
    this.labelContainer.appendChild(this.labelCanvas);

    // 主 canvas (可滚动区域内)
    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.cursor = 'grab';
    this.ctx = this.canvas.getContext('2d');
    this.container.appendChild(this.canvas);

    // Tooltip
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'swimlane-tooltip';
    this.tooltip.style.display = 'none';
    document.body.appendChild(this.tooltip);

    // 监听视口垂直滚动，将时间轴跟随显示
    const inner = this.container.parentElement;
    const viewport = inner ? inner.parentElement : null;
    if (viewport) {
      viewport.addEventListener('scroll', () => {
        this.yScrollTop = viewport.scrollTop;
        this._render();
        this._renderLabels();
      });
    }
  }

  _bindEvents() {
    // 标签区滚轮: 纵向滚动视口
    this.labelContainer.addEventListener('wheel', (e) => {
      e.preventDefault();
      const inner = this.container.parentElement;
      const viewport = inner ? inner.parentElement : null;
      if (viewport) viewport.scrollTop += e.deltaY * 0.8;
    }, { passive: false });

    // 主 canvas 滚轮:
    //   - 普通滚轮 (无修饰键): 时间轴水平缩放
    //   - Shift + 滚轮: 横向平移
    //   - Ctrl/Cmd + 滚轮: 也是缩放 (触控板 pinch-to-zoom 走这条路)
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;

      if (e.shiftKey) {
        // Shift + 滚轮 → 横向平移
        const dx = e.deltaY * 1.5;
        this.xOffset = Math.max(0, Math.min(this.xOffset + dx, this._maxXOffset()));
        this._render();
        this._renderLabels();
      } else {
        // 普通滚轮 / Ctrl 滚轮 → 时间粒度缩放，以鼠标为轴心
        const factor = e.deltaY < 0 ? SWIMLANE_CONFIG.ZOOM_FACTOR : 1 / SWIMLANE_CONFIG.ZOOM_FACTOR;
        this._zoom(factor, mouseX);
      }
    }, { passive: false });

    // 平移 (拖拽)
    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.dragStartX = e.clientX;
      this.dragStartOffset = this.xOffset;
      this.canvas.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDragging) {
        const dx = e.clientX - this.dragStartX;
        this.xOffset = Math.max(0, Math.min(
          this.dragStartOffset - dx,
          this._maxXOffset()
        ));
        this._render();
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

    this.canvas.addEventListener('click', (e) => {
      const { coreIndex } = this._hitTest(e);
      if (coreIndex >= 0) {
        const coreName = this.sortedCores[coreIndex];
        this.selectedCore = this.selectedCore === coreName ? null : coreName;
        if (this.onCoreClick) this.onCoreClick(coreName);
        this._render();
        this._renderLabels();
      }
    });
  }

  /**
   * 加载数据并初始化渲染
   */
  loadData(parsedData, analysisResult) {
    this.parsedData = parsedData;
    this.analysisResult = analysisResult;

    // 确定排序后的核心列表
    this.sortedCores = sortCoreNames([...parsedData.coreEvents.keys()])
      .filter(name => name !== 'Fake Core_0' && !name.startsWith('Fake'));

    // 可见核心
    this.visibleCores = new Set(this.sortedCores);

    // 瓶颈核心
    this.bottleneckCores = new Set();
    if (analysisResult?.bottlenecks) {
      analysisResult.bottlenecks.forEach(b => {
        b.affectedCores?.forEach(c => this.bottleneckCores.add(c));
      });
    }

    // 初始化视图
    this._initView();
    this._resize();
    this._render();
    this._renderLabels();
  }

  _initView() {
    if (!this.parsedData) return;
    const dur = this.parsedData.timeRange.duration;
    if (dur <= 0) return;
    const viewW = this._getViewportW();
    // 初始缩放：整段执行时间铺满视口，左右各留 8px 边距
    this.xScale = Math.max(0.001, (viewW - 16) / dur);
    this.xOffset = 0;
  }

  _resize() {
    const visibleRows = this._getVisibleCores();
    // 内容总高度 (用于滚动)
    const contentHeight = SWIMLANE_CONFIG.TIME_AXIS_HEIGHT + visibleRows.length * SWIMLANE_CONFIG.ROW_HEIGHT + 20;

    const dpr = window.devicePixelRatio || 1;
    const viewportW = this._getViewportW();
    const inner = this.container.parentElement;
    const viewport = inner ? inner.parentElement : null;
    const viewportH = viewport ? viewport.clientHeight : 400;

    // 主 canvas: 宽度 = 视口宽度(虚拟 pan), 高度 = 内容高度(真实垂直滚动)
    const canvasW = Math.max(viewportW, 100);
    const canvasH = Math.max(contentHeight, viewportH);

    this.canvas.width = canvasW * dpr;
    this.canvas.height = canvasH * dpr;
    this.canvas.style.width = `${canvasW}px`;
    this.canvas.style.height = `${canvasH}px`;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);

    // 标签 canvas: 同高
    this.labelCanvas.width = SWIMLANE_CONFIG.LABEL_WIDTH * dpr;
    this.labelCanvas.height = canvasH * dpr;
    this.labelCanvas.style.width = `${SWIMLANE_CONFIG.LABEL_WIDTH}px`;
    this.labelCanvas.style.height = `${canvasH}px`;
    this.labelCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.labelCtx.scale(dpr, dpr);
  }

  _getVisibleCores() {
    return this.sortedCores.filter(name => {
      if (!this.visibleCores.has(name)) return false;
      const type = getCoreType(name);
      if (type === 'AIC' && !this.showAIC) return false;
      if (type === 'AIV' && !this.showAIV) return false;
      return true;
    });
  }

  _getViewportW() {
    const inner = this.container.parentElement;
    const viewport = inner ? inner.parentElement : null;
    return viewport ? viewport.clientWidth - SWIMLANE_CONFIG.LABEL_WIDTH - 2 : 800;
  }

  _maxXOffset() {
    if (!this.parsedData) return 0;
    const viewW = this._getViewportW();
    const totalWidth = this.parsedData.timeRange.duration * this.xScale;
    // 精确夹紧：右边界不超出执行结束时刻，始终保留 80px 缓冲使末尾刻度可见
    return Math.max(0, totalWidth - viewW + 80);
  }

  _zoom(factor, centerX) {
    if (!this.parsedData) return;
    const oldScale = this.xScale;
    const viewW = this._getViewportW();

    // 缩小下限：至少能看到完整数据（不允许缩放到数据比视口还小之后仍继续缩小）
    const minScale = viewW / this.parsedData.timeRange.duration;
    const newScale = Math.max(minScale * 0.5, Math.min(this.xScale * factor, 5000));

    // 以鼠标 X 位置为轴心缩放，保持鼠标下方时间点不动
    const timeAtMouse = (this.xOffset + centerX) / oldScale;
    const newOffset = timeAtMouse * newScale - centerX;

    this.xScale = newScale;
    // 缩放后立即夹紧：不超出右边界，也不超出左边界
    this.xOffset = Math.max(0, Math.min(newOffset, this._maxXOffset()));

    this._resize();
    this._render();
    this._renderLabels();
  }

  /**
   * 主渲染函数
   */
  _render() {
    if (!this.parsedData) return;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.width / dpr;
    const H = this.canvas.height / dpr;

    ctx.clearRect(0, 0, W, H);

    // 背景
    ctx.fillStyle = SWIMLANE_CONFIG.BG_COLOR;
    ctx.fillRect(0, 0, W, H);

    const visibleCores = this._getVisibleCores();
    const { timeRange, coreEvents, colorMap } = this.parsedData;

    // 计算视口范围 (微秒)
    const viewStartTime = this.xOffset / this.xScale;
    const viewEndTime = (this.xOffset + W) / this.xScale;

    // 渲染时间轴 (固定在当前滚动位置顶部)
    const axisY = this.yScrollTop;
    this._renderTimeAxis(ctx, W, timeRange, viewStartTime, viewEndTime, axisY);

    // 渲染每一行
    visibleCores.forEach((coreName, rowIndex) => {
      const y = SWIMLANE_CONFIG.TIME_AXIS_HEIGHT + rowIndex * SWIMLANE_CONFIG.ROW_HEIGHT;
      const events = coreEvents.get(coreName) || [];

      this._renderRow(ctx, W, coreName, rowIndex, y, events, colorMap, timeRange, viewStartTime, viewEndTime);
    });

    // 渲染选中核心高亮边框
    if (this.selectedCore) {
      const idx = visibleCores.indexOf(this.selectedCore);
      if (idx >= 0) {
        const y = SWIMLANE_CONFIG.TIME_AXIS_HEIGHT + idx * SWIMLANE_CONFIG.ROW_HEIGHT;
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(0, y, W, SWIMLANE_CONFIG.ROW_HEIGHT);
      }
    }
  }

  _renderTimeAxis(ctx, W, timeRange, viewStartTime, viewEndTime, axisY = 0) {
    const axisH = SWIMLANE_CONFIG.TIME_AXIS_HEIGHT;
    const duration = timeRange.duration;
    const canvasH = this.canvas.height / (window.devicePixelRatio || 1);

    // ── 背景 ──────────────────────────────────────────────
    ctx.fillStyle = SWIMLANE_CONFIG.LABEL_BG;
    ctx.fillRect(0, axisY, W, axisH);

    // ── 超出范围的灰暗区域 ────────────────────────────────
    // 左侧 (t < 0, 理论上不会出现，xOffset >= 0)
    const xStart = -this.xOffset;          // t=0 对应的 canvas x
    const xEnd   = duration * this.xScale - this.xOffset; // t=duration 对应的 canvas x

    if (xStart > 0) {
      // 有左侧超出范围区域
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, axisY, xStart, axisH);
      ctx.fillRect(0, SWIMLANE_CONFIG.TIME_AXIS_HEIGHT, xStart, canvasH);
    }
    if (xEnd < W) {
      // 有右侧超出范围区域
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(xEnd, axisY, W - xEnd, axisH);
      ctx.fillRect(xEnd, SWIMLANE_CONFIG.TIME_AXIS_HEIGHT, W - xEnd, canvasH);
    }

    // ── 时间轴底部分割线 ──────────────────────────────────
    ctx.strokeStyle = SWIMLANE_CONFIG.AXIS_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, axisY + axisH);
    ctx.lineTo(W, axisY + axisH);
    ctx.stroke();

    // ── 计算刻度间隔 (只在 [0, duration] 范围内打刻度) ───
    const clampedStart = Math.max(0, viewStartTime);
    const clampedEnd   = Math.min(duration, viewEndTime);
    if (clampedEnd <= clampedStart) return;

    const viewDuration = clampedEnd - clampedStart;
    const targetTicks = Math.max(4, Math.floor(W / 80));
    const tickInterval = this._niceInterval(viewDuration / targetTicks);
    const firstTick = Math.ceil(clampedStart / tickInterval) * tickInterval;

    ctx.font = '10px monospace';
    ctx.textAlign = 'center';

    for (let t = firstTick; t <= clampedEnd + tickInterval * 0.01; t += tickInterval) {
      if (t < 0 || t > duration) continue;
      const x = t * this.xScale - this.xOffset;
      if (x < 0 || x > W) continue;

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

    // ── 起始边界线 (t=0) ─────────────────────────────────
    if (xStart >= 0 && xStart <= W) {
      ctx.strokeStyle = '#22D3EE';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(xStart, axisY);
      ctx.lineTo(xStart, canvasH);
      ctx.stroke();

      // 标签 "0"
      ctx.fillStyle = '#22D3EE';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'left';
      ctx.fillText('0', xStart + 3, axisY + axisH - 9);
    }

    // ── 结束边界线 (t=duration) ───────────────────────────
    if (xEnd >= 0 && xEnd <= W) {
      ctx.strokeStyle = '#F97316';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(xEnd, axisY);
      ctx.lineTo(xEnd, canvasH);
      ctx.stroke();
      ctx.setLineDash([]);

      // 结束标签
      ctx.fillStyle = '#F97316';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${this._formatTime(duration)} ►`, xEnd - 3, axisY + axisH - 9);
    }
  }

  _renderRow(ctx, W, coreName, rowIndex, y, events, colorMap, timeRange, viewStartTime, viewEndTime) {
    const rh = SWIMLANE_CONFIG.ROW_HEIGHT;
    const padding = SWIMLANE_CONFIG.ROW_PADDING;

    // 行背景
    const isBottleneck = this.highlightBottlenecks && this.bottleneckCores.has(coreName);
    const isSelected = coreName === this.selectedCore;
    const isHovered = coreName === this.hoveredCore;

    if (isSelected) {
      ctx.fillStyle = SWIMLANE_CONFIG.SELECTED_ROW_BG;
    } else if (isBottleneck) {
      ctx.fillStyle = SWIMLANE_CONFIG.BOTTLENECK_ROW_BG;
    } else if (isHovered) {
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
    } else {
      ctx.fillStyle = rowIndex % 2 === 0 ? 'rgba(255,255,255,0.0)' : 'rgba(255,255,255,0.02)';
    }
    ctx.fillRect(0, y, W, rh);

    // 分割线
    ctx.strokeStyle = SWIMLANE_CONFIG.AXIS_COLOR;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y + rh);
    ctx.lineTo(W, y + rh);
    ctx.stroke();

    // 渲染任务条
    events.forEach(event => {
      const relativeStart = event.ts - timeRange.start;
      const relativeEnd = relativeStart + (event.dur || 0);

      // 视口裁剪
      if (relativeEnd < viewStartTime || relativeStart > viewEndTime) return;

      const x = Math.max(0, relativeStart * this.xScale - this.xOffset);
      const endX = Math.min(W, relativeEnd * this.xScale - this.xOffset);
      const taskW = Math.max(SWIMLANE_CONFIG.MIN_TASK_WIDTH, endX - x);

      const op = getEventOpType(event);
      const color = colorMap[op] || '#64748B';

      const isHoveredEvent = event === this.hoveredEvent;

      // 任务条
      ctx.fillStyle = isHoveredEvent ? this._lightenColor(color, 40) : color;
      ctx.fillRect(x, y + padding, taskW, rh - padding * 2);

      // 任务名称 (只在宽度足够时显示)
      if (taskW > 30) {
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 2, y + padding, taskW - 4, rh - padding * 2);
        ctx.clip();
        const label = op.length > 12 ? op.substring(0, 11) + '…' : op;
        ctx.fillText(label, x + 2, y + rh - padding - 3);
        ctx.restore();
      }
    });

    // 气泡高亮 (任务间空隙)
    if (this.showBubbles && this.analysisResult?.coreMetrics) {
      const metrics = this.analysisResult.coreMetrics.get(coreName);
      if (metrics?.gaps) {
        metrics.gaps.forEach(gap => {
          if (gap.duration < 0.5) return; // 忽略极小 gap

          const relativeStart = gap.start - timeRange.start;
          const relativeEnd = gap.end - timeRange.start;

          if (relativeEnd < viewStartTime || relativeStart > viewEndTime) return;

          const x = Math.max(0, relativeStart * this.xScale - this.xOffset);
          const endX = Math.min(W, relativeEnd * this.xScale - this.xOffset);
          const gapW = Math.max(0.5, endX - x);

          ctx.fillStyle = SWIMLANE_CONFIG.BUBBLE_COLOR;
          ctx.fillRect(x, y + padding, gapW, rh - padding * 2);
        });
      }
    }
  }

  /**
   * 渲染左侧标签
   */
  _renderLabels() {
    if (!this.parsedData) return;
    const ctx = this.labelCtx;
    const W = SWIMLANE_CONFIG.LABEL_WIDTH;
    const H = this.labelCanvas.height / (window.devicePixelRatio || 1);

    ctx.clearRect(0, 0, W, H);

    // 背景
    ctx.fillStyle = SWIMLANE_CONFIG.LABEL_BG;
    ctx.fillRect(0, 0, W, H);

    // 时间轴标题区域 (与主 canvas 的时间轴对齐)
    const axisY = this.yScrollTop || 0;
    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, axisY, W, SWIMLANE_CONFIG.TIME_AXIS_HEIGHT);
    ctx.fillStyle = '#94A3B8';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('核心', W / 2, axisY + SWIMLANE_CONFIG.TIME_AXIS_HEIGHT / 2 + 4);

    // 分割线 (时间轴底部)
    ctx.strokeStyle = SWIMLANE_CONFIG.AXIS_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, axisY + SWIMLANE_CONFIG.TIME_AXIS_HEIGHT);
    ctx.lineTo(W, axisY + SWIMLANE_CONFIG.TIME_AXIS_HEIGHT);
    ctx.stroke();

    const visibleCores = this._getVisibleCores();

    visibleCores.forEach((coreName, rowIndex) => {
      const y = SWIMLANE_CONFIG.TIME_AXIS_HEIGHT + rowIndex * SWIMLANE_CONFIG.ROW_HEIGHT;
      const rh = SWIMLANE_CONFIG.ROW_HEIGHT;

      const isBottleneck = this.highlightBottlenecks && this.bottleneckCores.has(coreName);
      const isSelected = coreName === this.selectedCore;
      const isHovered = coreName === this.hoveredCore;

      // 行背景
      if (isSelected) {
        ctx.fillStyle = 'rgba(59, 130, 246, 0.2)';
      } else if (isBottleneck) {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
      } else if (isHovered) {
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
      } else {
        ctx.fillStyle = rowIndex % 2 === 0 ? SWIMLANE_CONFIG.LABEL_BG : 'rgba(255,255,255,0.02)';
      }
      ctx.fillRect(0, y, W, rh);

      // 核心类型图标
      const coreType = getCoreType(coreName);
      const typeColor = coreType === 'AIC' ? '#3B82F6' : coreType === 'AIV' ? '#10B981' : '#94A3B8';

      ctx.fillStyle = typeColor;
      ctx.fillRect(0, y + 3, 3, rh - 6);

      // 利用率颜色指示
      if (this.analysisResult?.coreMetrics) {
        const metrics = this.analysisResult.coreMetrics.get(coreName);
        if (metrics) {
          const utilColor = getRatingColor(metrics.utilization, 'utilization');
          ctx.fillStyle = utilColor + '33'; // 低透明度背景
          ctx.fillRect(3, y + 3, W - 6, rh - 6);
        }
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

  _handleMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const { coreIndex, event } = this._hitTest(e);

    const visibleCores = this._getVisibleCores();
    const newHoveredCore = coreIndex >= 0 ? visibleCores[coreIndex] : null;
    const changed = newHoveredCore !== this.hoveredCore || event !== this.hoveredEvent;

    this.hoveredCore = newHoveredCore;
    this.hoveredEvent = event;

    if (changed) {
      this._render();
      this._renderLabels();
    }

    // 更新 tooltip
    if (event && newHoveredCore) {
      this._showTooltip(e, event, newHoveredCore);
    } else {
      this._hideTooltip();
    }
  }

  _hitTest(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const rowIndex = Math.floor((mouseY - SWIMLANE_CONFIG.TIME_AXIS_HEIGHT) / SWIMLANE_CONFIG.ROW_HEIGHT);
    const visibleCores = this._getVisibleCores();

    if (rowIndex < 0 || rowIndex >= visibleCores.length) {
      return { coreIndex: -1, event: null };
    }

    const coreName = visibleCores[rowIndex];
    const events = this.parsedData?.coreEvents.get(coreName) || [];
    const timeRange = this.parsedData?.timeRange;

    // 找到鼠标位置对应的时间
    const timeAtMouse = (mouseX + this.xOffset) / this.xScale;
    const relativeTime = timeAtMouse; // 相对于全局起始

    // 二分查找附近的事件
    let hitEvent = null;
    for (const event of events) {
      const relStart = event.ts - timeRange.start;
      const relEnd = relStart + (event.dur || 0);
      if (relativeTime >= relStart - 0.5 && relativeTime <= relEnd + 0.5) {
        hitEvent = event;
        break;
      }
    }

    return { coreIndex: rowIndex, event: hitEvent };
  }

  _showTooltip(e, event, coreName) {
    const op = getEventOpType(event);
    const execHint = parseExecutionHint(event.args?.['execution-hint']);
    const taskId = event.args?.taskId || event.args?.TaskId || '';

    let html = `
      <div class="tt-header">
        <span class="tt-core">${coreName}</span>
        <span class="tt-op">${op}</span>
      </div>
      <div class="tt-body">
        <div class="tt-row"><span>任务名称</span><span>${event.name || '-'}</span></div>
        <div class="tt-row"><span>持续时间</span><span>${(event.dur || 0).toFixed(3)} μs</span></div>
        <div class="tt-row"><span>任务 ID</span><span>${taskId}</span></div>
    `;

    if (execHint) {
      if (execHint.avg) html += `<div class="tt-row"><span>平均时间</span><span>${execHint.avg.toFixed(3)} μs</span></div>`;
      if (execHint.max) html += `<div class="tt-row"><span>最大时间</span><span>${execHint.max.toFixed(3)} μs</span></div>`;
      if (execHint.min) html += `<div class="tt-row"><span>最小时间</span><span>${execHint.min.toFixed(3)} μs</span></div>`;
    }

    if (event.args?.['event-hint']) {
      const hint = event.args['event-hint'];
      const taskMatch = hint.match(/Task:\[([^\]]+)\]/);
      if (taskMatch) html += `<div class="tt-row"><span>Task ID</span><span>[${taskMatch[1]}]</span></div>`;
    }

    html += '</div>';

    this.tooltip.innerHTML = html;
    this.tooltip.style.display = 'block';

    const x = e.clientX + 12;
    const y = e.clientY - 10;
    const ttW = 260;
    const ttH = this.tooltip.offsetHeight;

    this.tooltip.style.left = `${Math.min(x, window.innerWidth - ttW - 10)}px`;
    this.tooltip.style.top = `${Math.max(5, y + ttH > window.innerHeight ? y - ttH - 20 : y)}px`;
  }

  _hideTooltip() {
    this.tooltip.style.display = 'none';
  }

  /**
   * 设置过滤器
   */
  setFilter(showAIC, showAIV) {
    this.showAIC = showAIC;
    this.showAIV = showAIV;
    this._resize();
    this._render();
    this._renderLabels();
  }

  toggleBubbles(show) {
    this.showBubbles = show;
    this._render();
  }

  toggleBottleneckHighlight(show) {
    this.highlightBottlenecks = show;
    this._render();
    this._renderLabels();
  }

  /**
   * 跳转到指定核心并高亮
   */
  scrollToCore(coreName) {
    const visibleCores = this._getVisibleCores();
    const idx = visibleCores.indexOf(coreName);
    if (idx < 0) return;

    this.selectedCore = coreName;

    // 计算该行的Y坐标并滚动到视口
    const y = SWIMLANE_CONFIG.TIME_AXIS_HEIGHT + idx * SWIMLANE_CONFIG.ROW_HEIGHT;
    const inner = this.container.parentElement;
    const viewport = inner ? inner.parentElement : null;
    if (viewport) {
      viewport.scrollTop = Math.max(0, y - viewport.clientHeight / 2);
    }

    this._render();
    this._renderLabels();
  }

  /**
   * 重置视图到全局范围
   */
  fitToView() {
    this._initView();
    this._resize();
    this._render();
  }

  /**
   * 导出当前视图为 PNG
   */
  exportPNG() {
    const link = document.createElement('a');
    link.download = 'swimlane_export.png';
    link.href = this.canvas.toDataURL('image/png');
    link.click();
  }

  /**
   * 处理容器大小变化
   */
  onResize() {
    this._resize();
    this._render();
    this._renderLabels();
  }

  // ---- 工具函数 ----

  _niceInterval(rawInterval) {
    const magnitudes = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    for (const m of magnitudes) {
      if (m >= rawInterval) return m;
    }
    return rawInterval;
  }

  _formatTime(us) {
    if (us >= 1000) return `${(us / 1000).toFixed(1)}ms`;
    if (us >= 1) return `${us.toFixed(0)}μs`;
    return `${us.toFixed(2)}μs`;
  }

  _lightenColor(hex, amount) {
    const num = parseInt(hex.slice(1), 16);
    const r = Math.min(255, (num >> 16) + amount);
    const g = Math.min(255, ((num >> 8) & 0xff) + amount);
    const b = Math.min(255, (num & 0xff) + amount);
    return `rgb(${r},${g},${b})`;
  }
}
