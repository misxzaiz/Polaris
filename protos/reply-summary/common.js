/* ============================================================
   reply-summary 原型 通用渲染 + 交互
   ============================================================ */
(function(){
  const D = window.DEMO_DATA;

  /* ---------- 通用 ---------- */
  function toggle(el){ el.classList.toggle('open'); }
  function svg(paths, cls){ return `<svg class="${cls||''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`; }
  const CHEV = svg('<path d="m6 9 6 6 6-6"/>');
  const ICON_BRAIN = svg('<path d="M9 3a3 3 0 0 1 6 0M12 5a7 7 0 0 1 7 7v2a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-2a7 7 0 0 1 7-7Z"/><path d="M9 20a3 3 0 0 0 6 0"/>');
  const ICON_FILE = svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>');
  const ICON_BOX = svg('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/>');

  /* ---------- 主题 ---------- */
  window.themeSw = function(checked){
    document.documentElement.className = checked ? 'theme-light' : 'theme-dark';
  };

  /* ---------- 助手上文 ---------- */
  window.renderAssistant = function(){
    const el = document.querySelector('[data-assistant]');
    if(el) el.innerHTML = `<div style="color:var(--text-primary);font-weight:500;margin-bottom:4px">🤖 Assistant</div><span>${D.assistantText}</span>`;
  };

  /* ---------- 理解分析 ---------- */
  window.renderThinking = function(container, collapsed){
    container.innerHTML = D.thinking.map((t,i)=>`
      <div class="thinking-block">
        <div class="thinking-header${collapsed?'':''}">
          ${ICON_BRAIN}<span style="color:var(--purple-400)">思考</span>
          <span class="cnt" style="margin-left:auto">${i+1}/${D.thinking.length}</span>
          ${CHEV}
        </div>
        <div class="thinking-body ${collapsed?'hidden':''}">${t}</div>
      </div>
    `).join('');
    container.querySelectorAll('.thinking-header').forEach(h=>{
      h.addEventListener('click', ()=>{
        toggle(h);
        const b = h.parentElement.querySelector('.thinking-body');
        if(b) b.classList.toggle('hidden');
      });
    });
  };

  /* ---------- 变更文件 ---------- */
  window.renderFiles = function(container){
    container.innerHTML = D.files.map(f=>{
      const color = f.changeType==='created' ? 'var(--green-400)' : f.changeType==='deleted' ? 'var(--red-400)' : 'var(--orange-400)';
      const icon = f.changeType==='created' ? ICON_FILE.replace('<path d="M14 2v4a2 2 0 0 0 2 2h4"/>','<path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 13h6M9 17h6"/>') : f.changeType==='deleted' ? ICON_FILE.replace('<path d="M14 2v4a2 2 0 0 0 2 2h4"/>','<path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15l3-3 3 3M12 12v6"/>') : ICON_FILE;
      return `
        <div class="file-row" data-file>
          ${svg(icon, 'f-ico')}
          <span class="fname">${f.name}</span>
          <span class="fdir" title="点击在编辑器中打开">${f.dir}</span>
          <span class="badge ${f.changeType}">${f.changeType==='created'?'新建':f.changeType==='deleted'?'已删除':'已修改'}</span>
          ${CHEV.replace('class="chev"','class="chev" style="width:12px;height:12px"')}
        </div>
        <div class="file-diff hidden" data-diff></div>
      `;
    }).join('');
    container.querySelectorAll('[data-file]').forEach(row=>{
      row.addEventListener('click', ()=>{
        row.classList.toggle('open');
        const diff = row.nextElementSibling;
        if(diff.dataset.rendered){ diff.classList.toggle('hidden'); return; }
        const f = D.files[[...container.querySelectorAll('[data-file]')].indexOf(row)];
        const content = f.diff ? f.diff : (f.content ? '（新文件内容占位）\n'+f.content : '');
        diff.innerHTML = content.split('\n').map(l=>{
          if(l.startsWith('+')) return `<span class="add">${l}</span>`;
          if(l.startsWith('-')) return `<span class="del">${l}</span>`;
          return `<span class="ctx">${l}</span>`;
        }).join('\n');
        diff.dataset.rendered = '1';
        diff.classList.remove('hidden');
      });
    });
  };

  /* ---------- PRD 预览 ---------- */
  window.renderPRD = function(container, collapsedPreview){
    const d = D.prd;
    container.innerHTML = `
      <div class="artifact-card">
        <div class="artifact-header">
          <div class="artifact-icon">${ICON_FILE.replace('class="f-ico"','')}</div>
          <div style="min-width:0">
            <div class="artifact-title">${d.title}</div>
            <div class="artifact-meta">
              <span>HTML</span><span class="dot-sep"></span><span>${d.size}</span>
              <span class="dot-sep"></span><span>${d.version}</span>
              <span class="dot-sep"></span><span>${d.createdAt}</span>
            </div>
          </div>
          <div class="artifact-actions">
            <button class="icon-btn" title="全屏预览">${svg('<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>')}</button>
            <button class="icon-btn" title="下载 HTML">${svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>')}</button>
            <button class="icon-btn" title="查看源码">${svg('<path d="m8 8-5 4 5 4M16 8l5 4-5 4M13 4l-2 16"/>')}</button>
          </div>
        </div>
        <div class="artifact-body">
          <iframe class="artifact-frame ${collapsedPreview?'hidden':''}" srcdoc="${d.html.replace(/"/g,'&quot;')}" sandbox="allow-scripts allow-forms allow-popups allow-modals"></iframe>
          ${collapsedPreview ? `
          <div class="artifact-collapsed open" data-prd-toggle>
            ${svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>','prd-ico')}
            <span class="sum">${d.description}</span>
            <span class="pct">预览已折叠 · 点击展开</span>
            ${CHEV}
          </div>` : ''}
        </div>
        ${!collapsedPreview ? `
        <div class="artifact-collapsed" data-prd-toggle>
          ${svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>','prd-ico')}
          <span class="sum">${d.description}</span>
          <span class="pct">点击收起预览</span>
          ${CHEV}
        </div>` : ''}
      </div>
    `;
    const t = container.querySelector('[data-prd-toggle]');
    if(t) t.addEventListener('click', function(){
      toggle(this);
      const body = this.closest('.artifact-card').querySelector('.artifact-frame');
      if(body) body.classList.toggle('hidden');
      const pct = this.querySelector('.pct');
      if(pct) pct.textContent = body.classList.contains('hidden') ? '预览已折叠 · 点击展开' : '点击收起预览';
    });
  };

  /* ---------- MCP 产物 ---------- */
  window.renderMCP = function(container){
    container.innerHTML = D.mcp.map(m=>{
      const color = m.color==='green' ? 'var(--green-400)' : 'var(--cyan-400)';
      return `
        <div class="file-row">
          ${svg('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/>','f-ico')}
          <span class="fname">${m.name}</span>
          <span class="fdir">${m.summary}</span>
        </div>
      `;
    }).join('');
  };

  /* ---------- 区段标题 toggle ---------- */
  window.bindSectionToggles = function(){
    document.querySelectorAll('.section-title[data-toggle]').forEach(h=>{
      h.addEventListener('click', ()=>{
        toggle(h);
        const body = h.parentElement.querySelector('[data-body]');
        if(body) body.classList.toggle('hidden');
      });
    });
  };
})();
