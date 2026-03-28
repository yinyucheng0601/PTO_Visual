/**
 * main.js - 应用主控制器
 * 协调各模块，处理用户交互和状态管理
 */

'use strict';

class App {
  constructor() {
    this.parsedData = null;
    this.analysisResult = null;
    this.swimlane = null;
    this.isLoading = false;

    this._initElements();
    this._initSwimlane();
    this._bindEvents();
    this._showWelcome();
  }

  _initElements() {
    this.fileInput = document.getElementById('fileInput');
    this.loadBtn = document.getElementById('loadBtn');
    this.fitBtn = document.getElementById('fitBtn');
    this.exportBtn = document.getElementById('exportBtn');
    this.zoomInBtn = document.getElementById('zoomInBtn');
    this.zoomOutBtn = document.getElementById('zoomOutBtn');
    this.showAICToggle = document.getElementById('showAIC');
    this.showAIVToggle = document.getElementById('showAIV');
    this.showBubblesToggle = document.getElementById('showBubbles');
    this.highlightBottlenecksToggle = document.getElementById('highlightBottlenecks');

    this.swimlaneViewport = document.getElementById('swimlaneViewport');
    this.swimlaneCanvas = document.getElementById('swimlaneCanvas');
    this.swimlaneLabel = document.getElementById('swimlaneLabel');

    this.loadingOverlay = document.getElementById('loadingOverlay');
    this.welcomePanel = document.getElementById('welcomePanel');
    this.mainContent = document.getElementById('mainContent');

    this.metricUtilization = document.getElementById('metricUtilization');
    this.metricBubble = document.getElementById('metricBubble');
    this.metricBalance = document.getElementById('metricBalance');
    this.metricTime = document.getElementById('metricTime');
    this.metricRating = document.getElementById('metricRating');

    this.chartUtilAIC = document.getElementById('chartUtilAIC');
    this.chartUtilAIV = document.getElementById('chartUtilAIV');
    this.chartBubble = document.getElementById('chartBubble');
    this.chartOps = document.getElementById('chartOps');
    this.chartHeatmap = document.getElementById('chartHeatmap');

    this.bottleneckList = document.getElementById('bottleneckList');
    this.recommendationList = document.getElementById('recommendationList');
    this.coreTableBody = document.getElementById('coreTableBody');

    this.tabBtns = document.querySelectorAll('.tab-btn');
    this.tabPanels = document.querySelectorAll('.tab-panel');

    this.coreTypeFilter = document.getElementById('coreTypeFilter');
    this.coreSearch = document.getElementById('coreSearch');
  }

  _initSwimlane() {
    this.swimlane = new SwimlaneRenderer(this.swimlaneCanvas, this.swimlaneLabel);
    this.swimlane.onCoreClick = (coreName) => {
      this._onCoreClick(coreName);
    };
  }

  _bindEvents() {
    // 文件加载
    this.loadBtn.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', (e) => this._onFileSelected(e));

    // 拖放加载
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file?.name.endsWith('.json')) this._loadFile(file);
    });

    // 视图控制
    this.fitBtn?.addEventListener('click', () => this.swimlane.fitToView());
    this.exportBtn?.addEventListener('click', () => this.swimlane.exportPNG());
    this.zoomInBtn?.addEventListener('click', () => {
      const W = this.swimlaneCanvas.clientWidth / 2;
      this.swimlane._zoom(1.5, W);
    });
    this.zoomOutBtn?.addEventListener('click', () => {
      const W = this.swimlaneCanvas.clientWidth / 2;
      this.swimlane._zoom(0.75, W);
    });

    // 过滤器
    this.showAICToggle?.addEventListener('change', () => this._applyFilters());
    this.showAIVToggle?.addEventListener('change', () => this._applyFilters());
    this.showBubblesToggle?.addEventListener('change', () => {
      this.swimlane.toggleBubbles(this.showBubblesToggle.checked);
    });
    this.highlightBottlenecksToggle?.addEventListener('change', () => {
      this.swimlane.toggleBottleneckHighlight(this.highlightBottlenecksToggle.checked);
    });

    // Tab 切换
    this.tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        this.tabBtns.forEach(b => b.classList.remove('active'));
        this.tabPanels.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`tab-${target}`)?.classList.add('active');
      });
    });

    // 核心表格过滤
    this.coreTypeFilter?.addEventListener('change', () => this._renderCoreTable());
    this.coreSearch?.addEventListener('input', () => this._renderCoreTable());

    // 窗口大小变化
    window.addEventListener('resize', () => {
      if (this.parsedData) {
        this.swimlane.onResize();
        this._renderCharts();
      }
    });
  }

  _onFileSelected(e) {
    const file = e.target.files[0];
    if (file) this._loadFile(file);
    e.target.value = '';
  }

  async _loadFile(file) {
    if (this.isLoading) return;
    this.isLoading = true;
    this._showLoading(`正在加载 ${file.name}...`);

    try {
      const text = await file.text();
      this._showLoading('正在解析数据...');

      // 使用 setTimeout 让 UI 更新
      await new Promise(resolve => setTimeout(resolve, 0));

      const data = JSON.parse(text);
      this.parsedData = parseTraceJSON(data);

      this._showLoading('正在分析性能...');
      await new Promise(resolve => setTimeout(resolve, 0));

      this.analysisResult = analyzePerformance(this.parsedData);

      this._showLoading('正在渲染...');
      await new Promise(resolve => setTimeout(resolve, 0));

      this._renderAll();
      this._showMain();

      // 更新文件名显示
      document.getElementById('fileName').textContent = file.name;
      document.getElementById('eventCount').textContent = `${this.parsedData.totalEventCount.toLocaleString()} 个事件`;
      document.getElementById('coreCount').textContent = `${this.parsedData.coreCount} 个核心`;

    } catch (err) {
      console.error('加载文件失败:', err);
      this._showError(`加载失败: ${err.message}`);
    } finally {
      this.isLoading = false;
    }
  }

  _renderAll() {
    this._renderSwimlane();
    this._renderMetricCards();
    this._renderCharts();
    this._renderBottlenecks();
    this._renderRecommendations();
    this._renderCoreTable();
  }

  _renderSwimlane() {
    this.swimlane.loadData(this.parsedData, this.analysisResult);
  }

  _renderMetricCards() {
    const { summaryMetrics, rating } = this.analysisResult;

    // 核心利用率
    this._updateMetricCard(
      this.metricUtilization,
      `${summaryMetrics.avgUtilization.toFixed(1)}%`,
      `AIC: ${summaryMetrics.avgAicUtilization.toFixed(1)}% · AIV: ${summaryMetrics.avgAivUtilization.toFixed(1)}%`,
      getRatingColor(summaryMetrics.avgUtilization, 'utilization'),
      summaryMetrics.allMetrics.map(m => m.utilization)
    );

    // 气泡率
    this._updateMetricCard(
      this.metricBubble,
      `${summaryMetrics.avgBubbleRate.toFixed(1)}%`,
      `AIC: ${summaryMetrics.avgAicBubbleRate.toFixed(1)}% · AIV: ${summaryMetrics.avgAivBubbleRate.toFixed(1)}%`,
      getRatingColor(summaryMetrics.avgBubbleRate, 'bubble'),
      summaryMetrics.allMetrics.map(m => m.bubbleRate)
    );

    // 负载均衡
    this._updateMetricCard(
      this.metricBalance,
      `${summaryMetrics.overallLoadBalance.toFixed(1)}%`,
      `AIC: ${summaryMetrics.aicLoadBalance.toFixed(1)}% · AIV: ${summaryMetrics.aivLoadBalance.toFixed(1)}%`,
      getRatingColor(summaryMetrics.overallLoadBalance, 'balance'),
      summaryMetrics.allMetrics.map(m => m.utilization)
    );

    // 执行时间
    const totalMs = summaryMetrics.totalExecutionTime;
    const timeLabel = totalMs >= 1000 ? `${(totalMs / 1000).toFixed(2)} ms` : `${totalMs.toFixed(1)} μs`;
    this._updateMetricCard(
      this.metricTime,
      timeLabel,
      `总任务数: ${summaryMetrics.totalTasks.toLocaleString()}`,
      CHART_COLORS?.neutral || '#3B82F6',
      null
    );

    // 综合评分
    if (this.metricRating) {
      this.metricRating.innerHTML = `
        <div class="metric-stars">${'★'.repeat(rating.stars)}${'☆'.repeat(5 - rating.stars)}</div>
        <div class="metric-label" style="color:${rating.color}">${rating.label}</div>
        <div class="metric-score">${rating.score.toFixed(0)} 分</div>
      `;
      this.metricRating.style.borderLeftColor = rating.color;
    }
  }

  _updateMetricCard(el, value, subtitle, color, sparkValues) {
    if (!el) return;
    const valueEl = el.querySelector('.metric-value');
    const subtitleEl = el.querySelector('.metric-subtitle');
    const sparkEl = el.querySelector('canvas');

    if (valueEl) valueEl.textContent = value;
    if (subtitleEl) subtitleEl.textContent = subtitle;
    if (el.style) el.style.borderLeftColor = color;

    if (sparkEl && sparkValues?.length > 1) {
      renderSparkline(sparkEl, sparkValues, color);
    }
  }

  _renderCharts() {
    if (!this.analysisResult) return;
    const { coreMetrics, opDistribution } = this.analysisResult;

    if (this.chartUtilAIC && this.chartUtilAIC.clientWidth > 0) {
      renderUtilizationChart(this.chartUtilAIC, coreMetrics, 'AIC');
    }
    if (this.chartUtilAIV && this.chartUtilAIV.clientWidth > 0) {
      renderUtilizationChart(this.chartUtilAIV, coreMetrics, 'AIV');
    }
    if (this.chartBubble && this.chartBubble.clientWidth > 0) {
      renderBubbleChart(this.chartBubble, coreMetrics, 'ALL');
    }
    if (this.chartOps && this.chartOps.clientWidth > 0) {
      renderOperationBreakdown(this.chartOps, opDistribution, this.parsedData.colorMap);
    }
    if (this.chartHeatmap && this.chartHeatmap.clientWidth > 0) {
      renderHeatmapChart(this.chartHeatmap, coreMetrics);
    }
  }

  _renderBottlenecks() {
    if (!this.bottleneckList) return;
    const { bottlenecks } = this.analysisResult;

    if (bottlenecks.length === 0) {
      this.bottleneckList.innerHTML = `
        <div class="no-issues">
          <span class="no-issues-icon">✓</span>
          <p>未检测到明显性能瓶颈</p>
        </div>`;
      return;
    }

    this.bottleneckList.innerHTML = bottlenecks.map((b, i) => `
      <div class="bottleneck-item severity-${b.severity}" data-core="${b.affectedCores?.[0] || ''}" data-index="${i}">
        <div class="b-header">
          <span class="b-severity severity-badge-${b.severity}">${b.severityLabel}</span>
          <span class="b-title">${b.type}</span>
          <span class="b-value">${b.value.toFixed(1)}${b.unit}</span>
        </div>
        <div class="b-desc">${b.description}</div>
        <div class="b-detail">${b.detail}</div>
        <div class="b-causes">
          <div class="b-causes-title">可能原因:</div>
          ${b.rootCause.map(c => `<div class="b-cause-item">• ${c}</div>`).join('')}
        </div>
        <div class="b-impact">
          <span class="b-impact-label">影响: </span>${b.impact}
        </div>
        ${b.affectedCores?.length > 0 ? `
        <div class="b-cores">
          <span class="b-cores-label">受影响核心: </span>
          ${b.affectedCores.map(c => `<span class="core-tag" onclick="app._jumpToCore('${c}')">${c}</span>`).join('')}
        </div>` : ''}
      </div>
    `).join('');

    // 点击跳转
    this.bottleneckList.querySelectorAll('.bottleneck-item').forEach(el => {
      el.addEventListener('click', () => {
        const coreName = el.dataset.core;
        if (coreName) this._jumpToCore(coreName);
      });
    });

    // 更新瓶颈计数徽章
    const badge = document.getElementById('bottleneckCount');
    if (badge) badge.textContent = bottlenecks.length;
  }

  _renderRecommendations() {
    if (!this.recommendationList) return;
    const { recommendations } = this.analysisResult;

    if (recommendations.length === 0) {
      this.recommendationList.innerHTML = `<div class="no-issues"><span class="no-issues-icon">✓</span><p>暂无优化建议</p></div>`;
      return;
    }

    const grouped = { high: [], medium: [], low: [] };
    recommendations.forEach(r => {
      const p = r.priority || 'low';
      if (grouped[p]) grouped[p].push(r);
      else grouped.low.push(r);
    });

    let html = '';
    const renderGroup = (items, label, cls) => {
      if (items.length === 0) return '';
      return `
        <div class="rec-group">
          <div class="rec-group-title ${cls}">${label}</div>
          ${items.map((r, i) => `
            <div class="rec-item">
              <div class="rec-header" onclick="this.parentElement.classList.toggle('expanded')">
                <span class="rec-num">${i + 1}</span>
                <span class="rec-title">${r.title}</span>
                <span class="rec-category cat-${r.category}">${getCategoryLabel(r.category)}</span>
                <span class="rec-expand">▼</span>
              </div>
              <div class="rec-body">
                <p class="rec-desc">${r.description}</p>
                ${r.code ? `
                <div class="rec-code-wrap">
                  <div class="rec-code-header">
                    <span>示例代码</span>
                    <button class="copy-btn" onclick="copyCode(this)">复制</button>
                  </div>
                  <pre class="rec-code"><code>${escapeHTML(r.code)}</code></pre>
                </div>` : ''}
              </div>
            </div>
          `).join('')}
        </div>`;
    };

    html += renderGroup(grouped.high, '🔴 高优先级优化', 'priority-high');
    html += renderGroup(grouped.medium, '🟡 中优先级优化', 'priority-medium');
    html += renderGroup(grouped.low, '🔵 低优先级优化', 'priority-low');

    this.recommendationList.innerHTML = html;

    const badge = document.getElementById('recCount');
    if (badge) badge.textContent = recommendations.length;
  }

  _renderCoreTable() {
    if (!this.coreTableBody || !this.analysisResult) return;
    const { coreMetrics } = this.analysisResult;

    const filterType = this.coreTypeFilter?.value || 'ALL';
    const searchText = (this.coreSearch?.value || '').toLowerCase();

    let cores = [...coreMetrics.values()];
    if (filterType !== 'ALL') cores = cores.filter(m => m.coreType === filterType);
    if (searchText) cores = cores.filter(m => m.coreName.toLowerCase().includes(searchText));

    cores = cores.sort((a, b) => {
      if (a.coreType !== b.coreType) {
        if (a.coreType === 'AIC') return -1;
        if (b.coreType === 'AIC') return 1;
        return 0;
      }
      return parseInt(a.coreName.replace(/\D/g, '')) - parseInt(b.coreName.replace(/\D/g, ''));
    });

    const isBottleneck = (name) => this.analysisResult.bottlenecks.some(b => b.affectedCores?.includes(name));

    this.coreTableBody.innerHTML = cores.map(m => {
      const utilColor = getRatingColor(m.utilization, 'utilization');
      const bubbleColor = getBubbleColor(m.bubbleRate);
      const isBn = isBottleneck(m.coreName);
      return `
        <tr class="${isBn ? 'row-bottleneck' : ''}" onclick="app._jumpToCore('${m.coreName}')" style="cursor:pointer">
          <td>
            <span class="core-type-badge type-${m.coreType}">${m.coreType}</span>
            ${m.coreName}
            ${isBn ? '<span class="warn-icon" title="存在性能瓶颈">⚠</span>' : ''}
          </td>
          <td>${m.taskCount}</td>
          <td>${m.totalActiveTime.toFixed(1)}</td>
          <td>
            <div class="util-bar-wrap">
              <div class="util-bar" style="width:${m.utilization.toFixed(1)}%;background:${utilColor}"></div>
              <span style="color:${utilColor}">${m.utilization.toFixed(1)}%</span>
            </div>
          </td>
          <td style="color:${bubbleColor}">${m.bubbleRate.toFixed(1)}%</td>
          <td>${m.avgDuration.toFixed(2)}</td>
          <td>${m.maxDuration.toFixed(2)}</td>
          <td>${m.idleTime.toFixed(1)}</td>
        </tr>`;
    }).join('');
  }

  _applyFilters() {
    const showAIC = this.showAICToggle?.checked ?? true;
    const showAIV = this.showAIVToggle?.checked ?? true;
    this.swimlane.setFilter(showAIC, showAIV);
  }

  _jumpToCore(coreName) {
    if (!coreName) return;
    this.swimlane.scrollToCore(coreName);

    // 在核心表中高亮
    this.coreTableBody?.querySelectorAll('tr').forEach(tr => {
      tr.classList.toggle('row-selected', tr.textContent.includes(coreName));
    });
  }

  _onCoreClick(coreName) {
    // 在分析面板中显示该核心的详细信息
    const metrics = this.analysisResult?.coreMetrics.get(coreName);
    if (!metrics) return;

    const panel = document.getElementById('coreDetailPanel');
    if (panel) {
      panel.style.display = 'block';
      panel.innerHTML = this._buildCoreDetailHTML(metrics);
    }
  }

  _buildCoreDetailHTML(m) {
    const opEntries = Object.entries(m.opBreakdown)
      .sort((a, b) => b[1].totalDuration - a[1].totalDuration)
      .slice(0, 5);

    return `
      <div class="core-detail">
        <div class="cd-header">
          <span class="core-type-badge type-${m.coreType}">${m.coreType}</span>
          <strong>${m.coreName}</strong>
          <button class="close-btn" onclick="document.getElementById('coreDetailPanel').style.display='none'">✕</button>
        </div>
        <div class="cd-metrics">
          <div class="cd-metric">
            <span class="cd-label">任务数</span>
            <span class="cd-value">${m.taskCount}</span>
          </div>
          <div class="cd-metric">
            <span class="cd-label">利用率</span>
            <span class="cd-value" style="color:${getRatingColor(m.utilization,'utilization')}">${m.utilization.toFixed(1)}%</span>
          </div>
          <div class="cd-metric">
            <span class="cd-label">气泡率</span>
            <span class="cd-value" style="color:${getBubbleColor(m.bubbleRate)}">${m.bubbleRate.toFixed(1)}%</span>
          </div>
          <div class="cd-metric">
            <span class="cd-label">活跃时间</span>
            <span class="cd-value">${m.totalActiveTime.toFixed(1)} μs</span>
          </div>
          <div class="cd-metric">
            <span class="cd-label">空闲时间</span>
            <span class="cd-value">${m.idleTime.toFixed(1)} μs</span>
          </div>
          <div class="cd-metric">
            <span class="cd-label">平均任务</span>
            <span class="cd-value">${m.avgDuration.toFixed(2)} μs</span>
          </div>
        </div>
        <div class="cd-section-title">Top 操作类型</div>
        ${opEntries.map(([op, s]) => `
          <div class="cd-op-row">
            <span class="cd-op-name">${op}</span>
            <span class="cd-op-count">${s.count}次</span>
            <span class="cd-op-time">${s.totalDuration.toFixed(1)} μs</span>
          </div>`).join('')}
      </div>`;
  }

  _showLoading(msg) {
    if (this.loadingOverlay) {
      this.loadingOverlay.style.display = 'flex';
      const msgEl = this.loadingOverlay.querySelector('.loading-msg');
      if (msgEl) msgEl.textContent = msg;
    }
  }

  _showMain() {
    if (this.loadingOverlay) this.loadingOverlay.style.display = 'none';
    if (this.welcomePanel) this.welcomePanel.style.display = 'none';
    if (this.mainContent) this.mainContent.style.display = 'flex';

    // 触发图表渲染 (需要 DOM 可见后才能获取尺寸)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this._renderCharts();
        this.swimlane.onResize();
      });
    });
  }

  _showWelcome() {
    if (this.welcomePanel) this.welcomePanel.style.display = 'flex';
    if (this.mainContent) this.mainContent.style.display = 'none';
    if (this.loadingOverlay) this.loadingOverlay.style.display = 'none';
  }

  _showError(msg) {
    if (this.loadingOverlay) this.loadingOverlay.style.display = 'none';
    const errEl = document.getElementById('errorToast');
    if (errEl) {
      errEl.textContent = msg;
      errEl.style.display = 'block';
      setTimeout(() => { errEl.style.display = 'none'; }, 5000);
    }
  }
}

// ---- 工具函数 ----

function getCategoryLabel(cat) {
  const labels = {
    scheduling: '调度优化',
    tiling: 'Tiling',
    loop_optimization: '循环优化',
    memory: '内存优化',
    graph_optimization: '图优化',
    architecture: '架构优化',
  };
  return labels[cat] || cat;
}

function escapeHTML(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function copyCode(btn) {
  const code = btn.closest('.rec-code-wrap').querySelector('code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    const orig = btn.textContent;
    btn.textContent = '已复制!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
}

// ---- 启动应用 ----
let app;
document.addEventListener('DOMContentLoaded', () => {
  app = new App();
});
