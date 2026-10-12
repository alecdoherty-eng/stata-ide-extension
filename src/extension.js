const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let stataProcess = null;
let activeDatasetPanel = null;
let graphWebviewPanel = null;
let plotHistory = [];
let activeDatasetWebview = null;
let pendingRequests = new Map();
let requestIdCounter = 0;
let heartbeatInterval = null;
let isEngineBusy = false;

let activeVariablesSubset = [];
let activeRowFilter = "";
let statusBarItem = null;

let lastClick = { id: null, time: 0 };
function isDoubleClick(id) {
    const now = Date.now();
    if (lastClick.id === id && (now - lastClick.time) < 400) {
        lastClick.id = null;
        return true;
    }
    lastClick = { id, time: now };
    return false;
}

// ============================================================================
// STATA RESULTS WEBVIEW PROVIDER (Console REPL)
// ============================================================================
class StataResultsViewProvider {
    constructor() { this._view = null; }
    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();
        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'execute') {
                const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                historyProvider.addCommand({ name: msg.code, code: msg.code, time: timeStr, isError: false });
                this.appendCommand(`\n. ${msg.code}\n`);

                sendToBackend({ cmd: 'execute', code: msg.code }).catch(err => {
                    this.appendError(`\n[Extension Error]: Failed to send command. ${err.message}\n`);
                });
            } else if (msg.type === 'execute_search') {
                vscode.commands.executeCommand('stata-ide.executeCode', msg.code);
            }
        });
    }
    appendCommand(text) { if (this._view) this._view.webview.postMessage({ type: 'command', text: text }); }
    appendOutput(text) { if (this._view) this._view.webview.postMessage({ type: 'output', text: text }); }
    appendError(text) { if (this._view) this._view.webview.postMessage({ type: 'error_text', text: text }); }
    clear() { if (this._view) this._view.webview.postMessage({ type: 'clear' }); }

    getHtml() {
        return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <style>
                body { display: flex; flex-direction: column; height: 100vh; margin: 0; padding: 0; font-family: monospace; background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-size: 13px; line-height: 1.4; }
                #output { flex: 1; overflow-y: auto; padding: 8px; white-space: pre-wrap; }
                #cli { display: flex; padding: 8px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background); align-items: flex-start; }
                #cli-prompt { color: #569cd6; margin-right: 8px; font-weight: bold; padding-top: 2px; }
                #cli-input { flex: 1; background: transparent; border: none; color: var(--vscode-input-foreground); font-family: monospace; font-size: 13px; outline: none; resize: none; overflow-y: hidden; box-sizing: border-box; line-height: 1.4; max-height: 150px; }
                .error-link { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; font-weight: bold; }
                .error-link:hover { text-decoration: underline; }
            </style>
        </head>
        <body>
            <div id="output"></div>
            <div id="cli">
                <span id="cli-prompt">.</span>
                <textarea id="cli-input" rows="1" placeholder="Type a Stata command and press Enter..."></textarea>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                const out = document.getElementById('output');
                const input = document.getElementById('cli-input');
                let isCommandBlock = false;
                
                const cmdHistory = [];
                let historyIndex = 0;

                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        const val = input.value.trim();
                        if (val) {
                            cmdHistory.push(val);
                            historyIndex = cmdHistory.length;
                            vscode.postMessage({ type: 'execute', code: val });
                            input.value = '';
                            input.style.height = 'auto';
                        }
                    } else if (e.key === 'ArrowUp' && input.selectionStart === 0) {
                        e.preventDefault();
                        if (historyIndex > 0) {
                            historyIndex--;
                            input.value = cmdHistory[historyIndex];
                            input.style.height = 'auto';
                            input.style.height = Math.min(input.scrollHeight, 150) + 'px';
                        }
                    } else if (e.key === 'ArrowDown' && input.selectionEnd === input.value.length) {
                        e.preventDefault();
                        if (historyIndex < cmdHistory.length - 1) {
                            historyIndex++;
                            input.value = cmdHistory[historyIndex];
                        } else {
                            historyIndex = cmdHistory.length;
                            input.value = '';
                        }
                        input.style.height = 'auto';
                        input.style.height = Math.min(input.scrollHeight, 150) + 'px';
                    }
                });

                input.addEventListener('input', function() {
                    this.style.height = 'auto';
                    this.style.height = Math.min(this.scrollHeight, 150) + 'px';
                });

                window.addEventListener('message', event => {
                    if (event.data.type === 'insert_cli') {
                        const needsSpace = input.value.length > 0 && !input.value.endsWith(' ');
                        input.value += (needsSpace ? ' ' : '') + event.data.text;
                        input.focus(); 
                        input.style.height = 'auto';
                        input.style.height = Math.min(input.scrollHeight, 150) + 'px';
                        return;
                    }
                    if (event.data.type === 'clear') { out.innerHTML = ''; isCommandBlock = false; return; }
                    
                    if (event.data.type === 'error_text') {
                        const span = document.createElement('span');
                        span.style.color = '#f14c4c'; 
                        
                        const text = event.data.text;
                        const regex = /r\\((\\d+)\\)/g;
                        let lastIndex = 0;
                        let match;
                        
                        while ((match = regex.exec(text)) !== null) {
                            if (match.index > lastIndex) {
                                span.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
                            }
                            
                            const rcCode = match[1]; 
                            const errSpan = document.createElement('span');
                            errSpan.textContent = match[0];
                            errSpan.className = 'error-link';
                            errSpan.title = "View help for return code " + rcCode;
                            
                            errSpan.onclick = function() {
                                vscode.postMessage({ type: 'execute_search', code: 'search rc ' + rcCode });
                            };
                            
                            span.appendChild(errSpan);
                            lastIndex = regex.lastIndex;
                        }
                        
                        if (lastIndex < text.length) {
                            span.appendChild(document.createTextNode(text.substring(lastIndex)));
                        }
                        
                        out.appendChild(span); 
                        out.scrollTop = out.scrollHeight;
                        isCommandBlock = false; 
                        return;
                    }
                    
                    const nl = String.fromCharCode(10);
                    const lines = event.data.text.split(nl);
                    
                    lines.forEach((line, index) => {
                        if (!line && index === lines.length - 1) return;
                        if (event.data.type === 'command' || line.startsWith('. ') || line.startsWith('> ')) { isCommandBlock = true; } 
                        else if (line.trim().length > 0) { isCommandBlock = false; }
                        
                        const span = document.createElement('span');
                        span.style.color = isCommandBlock ? '#569cd6' : '#d4d4d4'; 
                        span.textContent = line + (index < lines.length - 1 ? nl : '');
                        out.appendChild(span);
                    });
                    out.scrollTop = out.scrollHeight;
                });
            </script>
        </body>
        </html>`;
    }
}

// ============================================================================
// VARIABLES IN MEMORY WEBVIEW PROVIDER 
// ============================================================================
class StataVariablesViewProvider {
    constructor(context) {
        this.context = context;
        this._view = null;
        this.variables = [];
        this.selectedVars = new Set();
        this.frozenVars = new Set();
        this.filterText = "";
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.command === 'toggleSelect') {
                if (msg.state) this.selectedVars.add(msg.varName);
                else this.selectedVars.delete(msg.varName);
            } else if (msg.command === 'toggleAll') {
                if (msg.state) this.variables.forEach(v => this.selectedVars.add(v.name));
                else this.selectedVars.clear();
            } else if (msg.command === 'insertVariable') {
                vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
                setTimeout(() => {
                    if (resultsProvider._view && msg.varName) {
                        resultsProvider._view.webview.postMessage({ type: 'insert_cli', text: msg.varName });
                    }
                }, 50);
            } else if (msg.command === 'executeVariable') {
                const isNumeric = msg.varType.toLowerCase().includes('num') || !msg.varType.toLowerCase().startsWith('str');
                const code = isNumeric ? `summarize ${msg.varName}, detail` : `tabulate ${msg.varName}`;
                vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
                resultsProvider.appendCommand(`\n. ${code}\n`);
                sendToBackend({ cmd: "execute", code: code });
            } else if (msg.command === 'updateFilterText') {
                this.filterText = msg.text;
            } else if (msg.command === 'copyToClipboard') {
                vscode.env.clipboard.writeText(msg.text);
            } else if (msg.command === 'editVariable') {
                if (msg.newValue === msg.oldValue) return;

                const isNameEdit = msg.editType === 'name';
                const code = isNameEdit
                    ? `rename ${msg.varName} ${msg.newValue}`
                    : `label variable ${msg.varName} "${msg.newValue}"`;

                if (isNameEdit) {
                    if (this.selectedVars && this.selectedVars.has(msg.varName)) {
                        this.selectedVars.delete(msg.varName);
                        this.selectedVars.add(msg.newValue);
                    }
                    if (typeof activeVariablesSubset !== 'undefined') {
                        const idx = activeVariablesSubset.indexOf(msg.varName);
                        if (idx !== -1) activeVariablesSubset[idx] = msg.newValue;
                    }
                }

                const editor = vscode.window.activeTextEditor;
                if (editor && editor.document.languageId === 'stata') {
                    const document = editor.document;
                    let currentLine = editor.selection.active.line;
                    let targetLine = currentLine;

                    for (let i = currentLine; i < document.lineCount; i++) {
                        if (document.lineAt(i).text.trim() === '') break;
                        targetLine = i;
                    }

                    editor.edit(editBuilder => {
                        const targetPos = document.lineAt(targetLine).range.end;
                        editBuilder.insert(targetPos, '\n' + code);
                    }).then(() => {
                        const newPos = new vscode.Position(targetLine + 1, code.length);
                        editor.selection = new vscode.Selection(newPos, newPos);
                        editor.revealRange(new vscode.Range(newPos, newPos));
                    });
                }

                vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
                resultsProvider.appendCommand(`\n. ${code}\n`);
                sendToBackend({ cmd: "execute", code: code });
            }
        });

        if (this.variables.length > 0) {
            this.refresh(this.variables);
        }
    }

    refresh(newVariables) {
        if (newVariables) {
            const newNames = new Set(newVariables.map(v => v.name));
            this.selectedVars = new Set([...this.selectedVars].filter(x => newNames.has(x)));

            if (this.selectedVars.size === 0) {
                newVariables.forEach(v => this.selectedVars.add(v.name));
            }
            this.variables = newVariables;
        }

        if (this._view && this._view.webview) {
            this._view.webview.postMessage({
                type: 'updateVariables',
                variables: this.variables,
                selected: Array.from(this.selectedVars),
                frozen: Array.from(this.frozenVars)
            });
        }
    }

    setFrozen(frozenArray) {
        this.frozenVars = new Set(frozenArray);
        this.refresh();
    }

    selectAll() {
        this.variables.forEach(v => this.selectedVars.add(v.name));
        this.refresh();
    }

    unselectAll() {
        this.selectedVars.clear();
        this.refresh();
    }

    focusFilter() {
        if (this._view) this._view.webview.postMessage({ type: 'focusFilter' });
    }

    getHtml() {
        return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <style>
                body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background-color: var(--vscode-sideBar-background); display: flex; flex-direction: column; height: 100vh; overflow: hidden; user-select: none; }
                #filter-container { flex: 0 0 auto; padding: 8px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); }
                #var-filter { width: 100%; padding: 4px 6px; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); font-family: var(--vscode-font-family); outline: none; }
                #var-filter:focus { border: 1px solid var(--vscode-focusBorder); }
                #table-wrapper { flex: 1; overflow: auto; }
                table { width: 100%; border-collapse: collapse; table-layout: fixed; }
                th, td { padding: 4px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-bottom: 1px solid var(--vscode-panel-border); }
                th { position: sticky; top: 0; background-color: var(--vscode-sideBar-background); z-index: 10; font-weight: 600; cursor: pointer; box-shadow: 0 1px 0 var(--vscode-panel-border); }
                th:hover { background-color: var(--vscode-list-hoverBackground); }
                th.col-cb { width: 24px; text-align: center; }
                td.col-cb { text-align: center; cursor: pointer; }
                th.col-name, td.col-name { width: 35%; font-family: monospace; color: var(--vscode-symbolIcon-variableForeground); font-weight: bold; }
                th.col-type, td.col-type { width: 20%; font-size: 0.9em; opacity: 0.8; }
                th.col-label, td.col-label { width: 45%; font-size: 0.9em; }
                tr:hover { background-color: var(--vscode-list-hoverBackground); }
                tr.frozen td { background-color: rgba(130, 200, 255, 0.1); }
                
                tr.selected-row td { background-color: var(--vscode-list-activeSelectionBackground) !important; color: var(--vscode-list-activeSelectionForeground) !important; }
                tr.selected-row td.col-name { color: var(--vscode-list-activeSelectionForeground) !important; }
                
                .edit-input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-focusBorder); font-family: inherit; font-size: inherit; padding: 2px; outline: none; }
                td.editing { padding: 2px; }
                
                #ctx-menu { display: none; position: fixed; z-index: 1000; background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border); box-shadow: 0 2px 4px rgba(0,0,0,0.5); padding: 4px 0; color: var(--vscode-menu-foreground); min-width: 150px; font-size: 13px; }
                .ctx-menu-item { padding: 6px 12px; cursor: pointer; }
                .ctx-menu-item:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
            </style>
        </head>
        <body>
            <div id="filter-container">
                <input type="text" id="var-filter" placeholder="Filter variables..." />
            </div>
            <div id="table-wrapper">
                <table>
                    <thead>
                        <tr>
                            <th class="col-cb" id="toggle-all-cb" title="Select/Unselect All">✓</th>
                            <th class="col-name" id="sort-name">Name</th>
                            <th class="col-type">Type</th>
                            <th class="col-label">Label</th>
                        </tr>
                    </thead>
                    <tbody id="var-body"></tbody>
                </table>
            </div>
            
            <div id="ctx-menu">
                <div class="ctx-menu-item" id="ctx-copy">Copy Variable Name</div>
                <div class="ctx-menu-item" id="ctx-execute">Summarize / Tabulate</div>
            </div>
            
            <script>
                const vscode = acquireVsCodeApi();
                let allVariables = [];
                let selectedVars = new Set();
                let frozenVars = new Set();
                let filterText = "";
                let activeRowSelection = new Set();
                let lastClickedRowIndex = null;
                
                const filterInput = document.getElementById('var-filter');
                const tbody = document.getElementById('var-body');
                const toggleAllCb = document.getElementById('toggle-all-cb');
                const ctxMenu = document.getElementById('ctx-menu');
                let allSelected = true;
                let ctxTargetVar = null;
                let ctxTargetType = null;
                
                document.addEventListener('click', (e) => {
                    if (!ctxMenu.contains(e.target)) ctxMenu.style.display = 'none';
                });
                
                document.getElementById('ctx-copy').addEventListener('click', () => {
                    let varsToCopy = [];
                    if (activeRowSelection.size > 0 && activeRowSelection.has(ctxTargetVar)) {
                        Array.from(tbody.querySelectorAll('tr')).forEach(r => {
                            const n = r.getAttribute('data-name');
                            if (activeRowSelection.has(n)) varsToCopy.push(n);
                        });
                    } else {
                        varsToCopy = [ctxTargetVar];
                    }
                    vscode.postMessage({ command: 'copyToClipboard', text: varsToCopy.join(' ') });
                    ctxMenu.style.display = 'none';
                });

                document.getElementById('ctx-execute').addEventListener('click', () => {
                    vscode.postMessage({ command: 'executeVariable', varName: ctxTargetVar, varType: ctxTargetType });
                    ctxMenu.style.display = 'none';
                });
                
                filterInput.addEventListener('input', (e) => {
                    filterText = e.target.value.toLowerCase();
                    vscode.postMessage({ command: 'updateFilterText', text: filterText });
                    renderTable();
                });

                toggleAllCb.addEventListener('click', () => {
                    allSelected = !allSelected;
                    const checkboxes = tbody.querySelectorAll('input[type="checkbox"]');
                    checkboxes.forEach(cb => cb.checked = allSelected);
                    if (allSelected) allVariables.forEach(v => selectedVars.add(v.name));
                    else selectedVars.clear();
                    vscode.postMessage({ command: 'toggleAll', state: allSelected });
                    // Only visually update UI without full DOM rebuild
                    Array.from(tbody.querySelectorAll('tr')).forEach(tr => {
                        const isChecked = selectedVars.has(tr.getAttribute('data-name'));
                        tr.querySelector('input[type="checkbox"]').checked = isChecked;
                    });
                });
                
                window.addEventListener('message', event => {
                    if (event.data.type === 'updateVariables') {
                        allVariables = event.data.variables;
                        selectedVars = new Set(event.data.selected);
                        frozenVars = new Set(event.data.frozen);
                        renderTable();
                    } else if (event.data.type === 'focusFilter') {
                        filterInput.focus();
                    }
                });
                
                window.toggleVar = function(name, cb) {
                    const isChecked = cb.checked;
                    if(isChecked) selectedVars.add(name);
                    else selectedVars.delete(name);
                    vscode.postMessage({ command: 'toggleSelect', varName: name, state: isChecked });
                };
                
                function updateRowHighlights() {
                    Array.from(tbody.querySelectorAll('tr')).forEach(tr => {
                        if (activeRowSelection.has(tr.getAttribute('data-name'))) {
                            tr.classList.add('selected-row');
                        } else {
                            tr.classList.remove('selected-row');
                        }
                    });
                }
                
                function startEditing(td, isName, vName, originalText) {
                    if (td.classList.contains('editing')) return;
                    
                    td.classList.add('editing');
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'edit-input';
                    input.value = originalText;
                    
                    td.innerHTML = '';
                    td.appendChild(input);
                    input.focus();
                    input.setSelectionRange(0, input.value.length);
                    
                    let isFinished = false; 
                    
                    const finishEdit = (save) => {
                        if (isFinished) return;
                        isFinished = true;
                        td.classList.remove('editing');
                        const newValue = input.value.trim();
                        
                        if (save && newValue && newValue !== originalText) {
                            const varObj = allVariables.find(v => v.name === vName);
                            if (isName && varObj) varObj.name = newValue;
                            else if (!isName && varObj) varObj.label = newValue;
                            
                            if (isName) {
                                if (selectedVars.has(vName)) {
                                    selectedVars.delete(vName);
                                    selectedVars.add(newValue);
                                    vscode.postMessage({ command: 'toggleSelect', varName: vName, state: false });
                                    vscode.postMessage({ command: 'toggleSelect', varName: newValue, state: true });
                                }
                                if (activeRowSelection.has(vName)) {
                                    activeRowSelection.delete(vName);
                                    activeRowSelection.add(newValue);
                                }
                            }
                            
                            vscode.postMessage({
                                command: 'editVariable',
                                editType: isName ? 'name' : 'label',
                                varName: vName,
                                oldValue: originalText,
                                newValue: newValue
                            });
                            renderTable();
                        } else {
                            td.textContent = originalText;
                        }
                    };
                    
                    input.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') finishEdit(true);
                        if (e.key === 'Escape') finishEdit(false);
                    });
                    input.addEventListener('blur', () => finishEdit(true));
                }
                
                function renderTable() {
                    const scrollWrapper = document.getElementById('table-wrapper');
                    const currentScroll = scrollWrapper.scrollTop;
                    
                    let displayVars = allVariables;
                    if (filterText) {
                        displayVars = displayVars.filter(v => 
                            v.name.toLowerCase().includes(filterText) || 
                            (v.label && v.label.toLowerCase().includes(filterText))
                        );
                    }
                    
                    displayVars.sort((a, b) => {
                        const aSel = selectedVars.has(a.name);
                        const bSel = selectedVars.has(b.name);
                        if (aSel !== bSel) return aSel ? -1 : 1;
                        return a.index - b.index;
                    });
                    
                    let html = '';
                    displayVars.forEach(v => {
                        const isChecked = selectedVars.has(v.name);
                        const isFrozen = frozenVars.has(v.name);
                        const isHighlighted = activeRowSelection.has(v.name);
                        const rowClass = \`\${isFrozen ? 'frozen' : ''} \${isHighlighted ? 'selected-row' : ''}\`;
                        const safeLabel = (v.label || '').replace(/"/g, '&quot;');
                        
                        html += \`
                            <tr class="\${rowClass}" data-name="\${v.name}" data-type="\${v.type}" title="\${v.name}\\n\${safeLabel}\\nFormat: \${v.format}">
                                <td class="col-cb"><input type="checkbox" \${isChecked ? 'checked' : ''} onchange="toggleVar('\${v.name}', this)" /></td>
                                <td class="col-name" data-original="\${v.name}">\${v.name}\${isFrozen ? ' ❄' : ''}</td>
                                <td class="col-type">\${v.type}</td>
                                <td class="col-label" data-original="\${safeLabel}">\${v.label}</td>
                            </tr>
                        \`;
                    });
                    
                    tbody.innerHTML = html;
                    scrollWrapper.scrollTop = currentScroll;
                    
                    Array.from(tbody.querySelectorAll('tr')).forEach((tr, index) => {
                        tr.addEventListener('click', (e) => {
                            if (e.target.tagName.toLowerCase() === 'input') return;
                            const vName = tr.getAttribute('data-name');
                            if (e.ctrlKey || e.metaKey) {
                                if (activeRowSelection.has(vName)) activeRowSelection.delete(vName);
                                else activeRowSelection.add(vName);
                            } else if (e.shiftKey && lastClickedRowIndex !== null) {
                                const rows = Array.from(tbody.querySelectorAll('tr'));
                                const start = Math.min(lastClickedRowIndex, index);
                                const end = Math.max(lastClickedRowIndex, index);
                                activeRowSelection.clear();
                                for (let i = start; i <= end; i++) activeRowSelection.add(rows[i].getAttribute('data-name'));
                            } else {
                                activeRowSelection.clear();
                                activeRowSelection.add(vName);
                            }
                            lastClickedRowIndex = index;
                            updateRowHighlights();
                        });

                        tr.addEventListener('dblclick', (e) => {
                            if (e.target.tagName.toLowerCase() === 'input') return;
                            
                            const td = e.target.closest('td');
                            const vName = tr.getAttribute('data-name');
                            
                            if (td && td.classList.contains('col-name')) {
                                e.stopPropagation();
                                startEditing(td, true, vName, td.getAttribute('data-original'));
                                return;
                            }
                            if (td && td.classList.contains('col-label')) {
                                e.stopPropagation();
                                startEditing(td, false, vName, td.getAttribute('data-original'));
                                return;
                            }
                            vscode.postMessage({ command: 'insertVariable', varName: vName });
                        });
                        
                        tr.addEventListener('contextmenu', (e) => {
                            e.preventDefault();
                            const vName = tr.getAttribute('data-name');
                            if (!activeRowSelection.has(vName)) {
                                activeRowSelection.clear();
                                activeRowSelection.add(vName);
                                updateRowHighlights();
                                lastClickedRowIndex = index;
                            }
                            ctxTargetVar = vName;
                            ctxTargetType = tr.getAttribute('data-type');
                            document.getElementById('ctx-copy').textContent = activeRowSelection.size > 1 ? \`Copy \${activeRowSelection.size} Variables\` : 'Copy Variable';
                            ctxMenu.style.display = 'block';
                            ctxMenu.style.left = e.clientX + 'px';
                            ctxMenu.style.top = e.clientY + 'px';
                        });
                    });
                }
            </script>
        </body>
        </html>`;
    }
}

// ============================================================================
// STORED RESULTS & HISTORY PROVIDERS
// ============================================================================
class StoredResultsProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.results = { r: {}, e: {}, s: {}, g: {} };
    }
    refresh(data) {
        if (data) this.results = data;
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        if (['r() Macros & Scalars', 'e() Estimation', 's() System', '$ Globals'].includes(element.label)) {
            const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
            item.iconPath = new vscode.ThemeIcon('symbol-class');
            return item;
        }
        const item = new vscode.TreeItem(element.key, vscode.TreeItemCollapsibleState.None);
        item.description = String(element.value);
        item.iconPath = new vscode.ThemeIcon(isNaN(element.value) ? 'symbol-text' : 'symbol-constant');
        item.tooltip = `${element.key} =${element.value}`;
        item.command = { command: 'stata-ide.results.insert', title: 'Insert', arguments: [element] };
        return item;
    }
    getChildren(element) {
        if (!element) {
            return Promise.resolve([
                { label: '$ Globals', type: 'g' },
                { label: 'r() Macros & Scalars', type: 'r' },
                { label: 'e() Estimation', type: 'e' },
                { label: 's() System', type: 's' }
            ]);
        }
        const dataMap = this.results[element.type] || {};
        const children = Object.entries(dataMap).map(([k, v]) => ({ key: k, value: v, prefix: element.type }));
        return Promise.resolve(children);
    }
}

class HistoryProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.history = [];
    }
    addCommand(entry) {
        if (entry && entry.code && entry.code.trim()) { this.history.push(entry); this._onDidChangeTreeData.fire(); }
    }
    markLastError() {
        if (this.history.length > 0) { this.history[this.history.length - 1].isError = true; this._onDidChangeTreeData.fire(); }
    }
    getTreeItem(element) {
        const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
        item.description = element.time;
        item.tooltip = element.code;
        item.iconPath = element.isError ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')) : new vscode.ThemeIcon('history');
        item.command = { command: 'stata-ide.history.populate', title: 'Populate', arguments: [element] };
        return item;
    }
    getChildren() { return Promise.resolve(this.history); }
}

const resultsProvider = new StataResultsViewProvider();
const variablesProvider = new StataVariablesViewProvider();
const storedResultsProvider = new StoredResultsProvider();
const historyProvider = new HistoryProvider();

// ============================================================================
// CUSTOM FOLDING PROVIDER
// ============================================================================
class StataFoldingRangeProvider {
    provideFoldingRanges(document, context, token) {
        const ranges = [];
        let currentFoldStart = -1;

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i).text;

            if (/^\s*\*\*\#/.test(line)) {
                let headerTop = i;
                while (headerTop > 0 && /^\s*\*+\s*$/.test(document.lineAt(headerTop - 1).text)) {
                    headerTop--;
                }

                if (currentFoldStart !== -1) {
                    let endLine = headerTop - 1;
                    while (endLine > currentFoldStart && document.lineAt(endLine).text.trim() === '') {
                        endLine--;
                    }
                    if (endLine > currentFoldStart) {
                        ranges.push(new vscode.FoldingRange(currentFoldStart, endLine, vscode.FoldingRangeKind.Region));
                    }
                }

                let headerBottom = i;
                while (headerBottom < document.lineCount - 1 && /^\s*\*/.test(document.lineAt(headerBottom + 1).text)) {
                    headerBottom++;
                }

                currentFoldStart = headerBottom;
                i = headerBottom;
            }
        }

        if (currentFoldStart !== -1 && currentFoldStart < document.lineCount - 1) {
            ranges.push(new vscode.FoldingRange(currentFoldStart, document.lineCount - 1, vscode.FoldingRangeKind.Region));
        }

        return ranges;
    }
}

// ============================================================================
// CODELENS CHUNKING PROVIDER
// ============================================================================
class StataCodeLensProvider {
    provideCodeLenses(document, token) {
        const lenses = [];
        let startLine = -1;
        let currentCellName = "Code Cell";

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const match = line.text.match(/^\s*\*\*\#\s*(.*)$/);

            if (match) {
                if (startLine !== -1) {
                    const range = new vscode.Range(startLine, 0, i, 0);
                    lenses.push(new vscode.CodeLens(new vscode.Range(startLine, 0, startLine, 0), {
                        title: "$(play) Run Cell",
                        command: "stata-ide.runCell",
                        arguments: [range, document, currentCellName]
                    }));
                }
                startLine = i;
                currentCellName = match[1].trim() || "Code Cell";
            }
        }
        if (startLine !== -1) {
            const lastLine = document.lineAt(document.lineCount - 1);
            const range = new vscode.Range(startLine, 0, document.lineCount - 1, lastLine.text.length);
            lenses.push(new vscode.CodeLens(new vscode.Range(startLine, 0, startLine, 0), {
                title: "$(play) Run Cell",
                command: "stata-ide.runCell",
                arguments: [range, document, currentCellName]
            }));
        }
        return lenses;
    }
}

// ============================================================================
// OFFLINE BINARY .DTA VIEWER PROVIDER
// ============================================================================
class StataOfflineViewerProvider {
    constructor(context) { this.context = context; }
    async openCustomDocument(uri, openContext, token) { return { uri, dispose: () => { } }; }
    async resolveCustomEditor(document, webviewPanel, token) {
        webviewPanel.webview.options = { enableScripts: true };
        webviewPanel.webview.html = getGridHtml('fetch_chunk');
        const config = vscode.workspace.getConfiguration('stata-ide');
        const pythonPath = config.get('pythonPath') || 'python';
        const scriptPath = path.join(this.context.extensionPath, 'backend', 'offline_dta.py');
        const offlineProcess = spawn(pythonPath, [scriptPath, document.uri.fsPath]);

        offlineProcess.on('error', (err) => {
            vscode.window.showErrorMessage(`Failed to start Offline Viewer: ${err.message}. Check your Python path in settings.`);
        });

        let stdoutBuffer = "";
        offlineProcess.stdout.on('data', (data) => {
            stdoutBuffer += data.toString();
            let newlineIdx;
            while ((newlineIdx = stdoutBuffer.indexOf('\n')) > -1) {
                const line = stdoutBuffer.substring(0, newlineIdx);
                stdoutBuffer = stdoutBuffer.substring(newlineIdx + 1);
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.type === 'metadata') {
                        webviewPanel.webview.postMessage({ type: 'chunkData', data: [], total: parsed.total, columns: parsed.columns });
                    } else if (parsed.type === 'dataChunk') {
                        parsed.type = 'chunkData';
                        webviewPanel.webview.postMessage(parsed);
                    } else if (parsed.type === 'error') {
                        vscode.window.showErrorMessage(`Offline Viewer Error: ${parsed.data}`);
                    }
                } catch (e) { }
            }
        });

        webviewPanel.webview.onDidReceiveMessage(e => {
            if (e.command === 'fetch_chunk' && offlineProcess.stdin) {
                offlineProcess.stdin.write(JSON.stringify({ cmd: 'fetch_chunk', start: e.start, end: e.end, scrollToken: e.scrollToken }) + '\n');
            } else if (e.command === 'copyToClipboard') {
                vscode.env.clipboard.writeText(e.text);
            }
        });

        webviewPanel.onDidDispose(() => { if (offlineProcess) { offlineProcess.kill(); } });
    }
}

// ============================================================================
// LANGUAGE INTELLIGENCE 
// ============================================================================
const semanticLegend = new vscode.SemanticTokensLegend(
    ['keyword', 'function', 'variable'], // Token types
    ['declaration']                      // Token modifiers
);

class StataSemanticTokenProvider {
    provideDocumentSemanticTokens(document) {
        const builder = new vscode.SemanticTokensBuilder(semanticLegend);
        const chainPrefixes = ['quietly', 'qui', 'noisily', 'noi', 'capture', 'cap'];

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i).text;
            if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) continue;

            const wordRegex = /[a-zA-Z0-9_]+/g;
            let match;
            let expectCommand = true;

            while ((match = wordRegex.exec(line)) !== null) {
                const word = match[0];
                const wordLower = word.toLowerCase();
                const index = match.index;

                const prefixString = line.substring(0, index).trim();
                if (prefixString.endsWith(':')) {
                    expectCommand = true;
                }

                if (expectCommand) {
                    const docMatch = stataHelpDocs.find(d => wordLower.length >= d.min && d.cmd.startsWith(wordLower));

                    if (docMatch) {
                        builder.push(i, index, word.length, 0, 0);
                        if (chainPrefixes.includes(wordLower)) {
                            expectCommand = true;
                        } else {
                            expectCommand = false;
                        }
                    } else {
                        expectCommand = false;
                    }
                }
            }
        }
        return builder.build();
    }
}

let stataDiagnosticCollection;
let lintTimeout;

function lintStataDocument(document, variablesProvider) {
    if (document.languageId !== 'stata') return;

    const diagnostics = [];
    let inBlockComment = false;
    const bracketStack = [];

    const activeVars = variablesProvider.variables.map(v => v.name);
    const hasData = activeVars.length > 0;
    const dataCmdRegex = /^\s*(summarize|sum|regress|reg|tabulate|tab|keep|drop|sort|codebook|inspect)\b/;

    for (let lineIdx = 0; lineIdx < document.lineCount; lineIdx++) {
        const line = document.lineAt(lineIdx);
        const text = line.text;

        if (!inBlockComment && /^\s*\*/.test(text)) continue;

        let inCompoundString = false;
        let inString = false;
        let cleanCode = "";

        let i = 0;
        while (i < text.length) {
            if (inBlockComment) {
                if (text.substring(i, i + 2) === '*/') { inBlockComment = false; i += 2; }
                else { i++; }
                continue;
            }
            if (text.substring(i, i + 2) === '/*') { inBlockComment = true; i += 2; continue; }
            if (text.substring(i, i + 2) === '//') break;

            if (inCompoundString) {
                if (text.substring(i, i + 2) === '"\'') { inCompoundString = false; i += 2; }
                else { i++; }
                continue;
            }
            if (text.substring(i, i + 2) === '`"') { inCompoundString = true; i += 2; continue; }
            if (inString) {
                if (text[i] === '"') inString = false;
                i++;
                continue;
            }
            if (text[i] === '"') { inString = true; i++; continue; }

            const char = text[i];
            if (char === '{' || char === '(') {
                bracketStack.push({ char, line: lineIdx, col: i });
            } else if (char === '}' || char === ')') {
                const expectedMatch = char === '}' ? '{' : '(';
                if (bracketStack.length === 0 || bracketStack[bracketStack.length - 1].char !== expectedMatch) {
                    const range = new vscode.Range(lineIdx, i, lineIdx, i + 1);
                    diagnostics.push(new vscode.Diagnostic(range, `Unmatched closing bracket '${char}'`, vscode.DiagnosticSeverity.Error));
                } else {
                    bracketStack.pop();
                }
            }
            cleanCode += char;
            i++;
        }

        if (hasData && !inBlockComment && dataCmdRegex.test(text)) {
            if (!text.includes('`') && !text.includes('$')) {
                const mainClause = cleanCode.split(',')[0].split(/\b(if|in)\b/)[0];
                const parts = mainClause.trim().split(/\s+/);

                for (let j = 1; j < parts.length; j++) {
                    const token = parts[j];
                    if (!token || token.includes('*') || token.includes('?') || token.includes('-') || !isNaN(token)) continue;

                    const isValid = activeVars.some(v => v.startsWith(token));
                    if (!isValid) {
                        const regex = new RegExp(`\\b${token}\\b`);
                        const match = regex.exec(text);
                        if (match) {
                            const range = new vscode.Range(lineIdx, match.index, lineIdx, match.index + token.length);
                            diagnostics.push(new vscode.Diagnostic(range, `Variable '${token}' not found in active dataset.`, vscode.DiagnosticSeverity.Warning));
                        }
                    }
                }
            }
        }
    }

    bracketStack.forEach(b => {
        const range = new vscode.Range(b.line, b.col, b.line, b.col + 1);
        diagnostics.push(new vscode.Diagnostic(range, `Unclosed opening bracket '${b.char}'`, vscode.DiagnosticSeverity.Error));
    });

    stataDiagnosticCollection.set(document.uri, diagnostics);
}

const stataHelpDocs = [
    { cmd: "byte", min: 4, help: "Byte data type (integers between -127 and 100)." },
    { cmd: "int", min: 3, help: "Integer data type (-32,767 to 32,740)." },
    { cmd: "long", min: 4, help: "Long integer data type." },
    { cmd: "float", min: 5, help: "Float data type (4-byte real, ~7 digits accuracy)." },
    { cmd: "double", min: 6, help: "Double data type (8-byte real, ~16 digits accuracy)." },
    { cmd: "str", min: 3, help: "String data type (e.g., str1, str20, strL)." },
    { cmd: "by", min: 2, help: "Repeat command on subsets of the data.\n\n**Syntax:** `by varlist: command`" },
    { cmd: "bysort", min: 3, help: "Sort data and repeat command on subsets.\n\n**Syntax:** `bysort varlist: command`" },
    { cmd: "mi", min: 2, help: "Multiple imputation commands." },
    { cmd: "svy", min: 3, help: "Survey data estimation prefix." },
    { cmd: "append", min: 3, help: "Append datasets.\n\n**Syntax:** `append using filename [, options]`" },
    { cmd: "clear", min: 2, help: "Clear data from memory.\n\n**Syntax:** `clear [all]`" },
    { cmd: "codebook", min: 2, help: "Produce a codebook describing data contents.\n\n**Syntax:** `codebook [varlist] [if] [in] [, options]`" },
    { cmd: "collapse", min: 3, help: "Make dataset of summary statistics.\n\n**Syntax:** `collapse (stat) newvar=var ... [, options]`" },
    { cmd: "compress", min: 4, help: "Compress data in memory.\n\n**Syntax:** `compress [varlist]`" },
    { cmd: "decode", min: 3, help: "Decode labeled numeric variables into string.\n\n**Syntax:** `decode varname, generate(newvar)`" },
    { cmd: "describe", min: 1, help: "Describe data in memory or in file.\n\n**Syntax:** `describe [varlist] [, options]`" },
    { cmd: "destring", min: 3, help: "Convert string variables to numeric.\n\n**Syntax:** `destring [varlist], generate(newvarlist) | replace [options]`" },
    { cmd: "drop", min: 2, help: "Eliminate variables or observations.\n\n**Syntax:** `drop varlist` or `drop if exp`" },
    { cmd: "edit", min: 2, help: "Open data editor.\n\n**Syntax:** `edit [varlist] [if] [in]`" },
    { cmd: "egen", min: 4, help: "Extensions to generate.\n\n**Syntax:** `egen [type] newvar = fcn(arguments) [if] [in] [, options]`" },
    { cmd: "encode", min: 3, help: "Encode string into numeric and label.\n\n**Syntax:** `encode varname, generate(newvar)`" },
    { cmd: "export", min: 3, help: "Export data to external files.\n\n**Syntax:** `export excel/delimited ...`" },
    { cmd: "format", min: 3, help: "Set display format for variables.\n\n**Syntax:** `format varlist %fmt`" },
    { cmd: "generate", min: 3, help: "Create or change contents of variable.\n\n**Syntax:** `generate [type] newvar = exp [if] [in]`" },
    { cmd: "gsort", min: 3, help: "Ascending and descending sort.\n\n**Syntax:** `gsort [+|-] varname ...`" },
    { cmd: "import", min: 3, help: "Import data from external files.\n\n**Syntax:** `import excel/delimited ...`" },
    { cmd: "inspect", min: 3, help: "Display simple summary of data's attributes.\n\n**Syntax:** `inspect [varlist] [if] [in]`" },
    { cmd: "keep", min: 2, help: "Keep variables or observations.\n\n**Syntax:** `keep varlist` or `keep if exp`" },
    { cmd: "label", min: 2, help: "Manipulate labels.\n\n**Syntax:** `label data/variable/values ...`" },
    { cmd: "levelsof", min: 5, help: "Distinct levels of a variable.\n\n**Syntax:** `levelsof varname [if] [in] [, options]`" },
    { cmd: "list", min: 1, help: "List values of variables.\n\n**Syntax:** `list [varlist] [if] [in] [, options]`" },
    { cmd: "merge", min: 3, help: "Merge datasets.\n\n**Syntax:** `merge 1:1|m:1|1:m|m:m varlist using filename [, options]`" },
    { cmd: "order", min: 2, help: "Reorder variables in dataset.\n\n**Syntax:** `order varlist [, first | last | before(var) | after(var)]`" },
    { cmd: "preserve", min: 4, help: "Preserve data in memory.\n\n**Syntax:** `preserve`" },
    { cmd: "recode", min: 3, help: "Recode categorical variables.\n\n**Syntax:** `recode varlist (rule) ... [, options]`" },
    { cmd: "rename", min: 3, help: "Rename variable.\n\n**Syntax:** `rename oldvar newvar`" },
    { cmd: "replace", min: 3, help: "Replace contents of existing variable.\n\n**Syntax:** `replace oldvar = exp [if] [in]`" },
    { cmd: "reshape", min: 4, help: "Convert data from wide to long form and vice versa.\n\n**Syntax:** `reshape long/wide stub, i(varlist) j(varname)`" },
    { cmd: "restore", min: 4, help: "Restore preserved data.\n\n**Syntax:** `restore [, preserve]`" },
    { cmd: "save", min: 2, help: "Save dataset.\n\n**Syntax:** `save [filename] [, replace]`" },
    { cmd: "sort", min: 2, help: "Sort data.\n\n**Syntax:** `sort varlist [in] [, stable]`" },
    { cmd: "sysuse", min: 3, help: "Use shipped dataset.\n\n**Syntax:** `sysuse filename [, clear]`" },
    { cmd: "tostring", min: 3, help: "Convert numeric variables to string.\n\n**Syntax:** `tostring varlist, generate(newvarlist) | replace [options]`" },
    { cmd: "use", min: 1, help: "Load Stata dataset.\n\n**Syntax:** `use [varlist] [if] [in] using filename [, clear]`" },
    { cmd: "anova", min: 2, help: "Analysis of variance and covariance.\n\n**Syntax:** `anova varname [term [term ...]] [if] [in] [weight] [, options]`" },
    { cmd: "areg", min: 4, help: "Linear regression with a large dummy-variable set.\n\n**Syntax:** `areg depvar [indepvars], absorb(varname) [options]`" },
    { cmd: "arima", min: 3, help: "ARIMA, ARMAX, and other dynamic regression models.\n\n**Syntax:** `arima depvar [indepvars] [if] [in] [weight] [, options]`" },
    { cmd: "correlate", min: 3, help: "Display correlation matrix or covariance matrix.\n\n**Syntax:** `correlate [varlist] [if] [in] [weight] [, options]`" },
    { cmd: "count", min: 3, help: "Count observations satisfying specified conditions.\n\n**Syntax:** `count [if] [in]`" },
    { cmd: "estat", min: 3, help: "Postestimation statistics.\n\n**Syntax:** `estat subcommand [, options]`" },
    { cmd: "estimates", min: 3, help: "Manage estimation results.\n\n**Syntax:** `estimates store/restore/table ...`" },
    { cmd: "logit", min: 3, help: "Logistic regression.\n\n**Syntax:** `logit depvar [indepvars] [if] [in] [weight] [, options]`" },
    { cmd: "margins", min: 3, help: "Marginal means, predictive margins, and marginal effects.\n\n**Syntax:** `margins [marginlist] [if] [in] [weight] [, options]`" },
    { cmd: "mean", min: 2, help: "Estimate means.\n\n**Syntax:** `mean varlist [if] [in] [weight] [, options]`" },
    { cmd: "predict", min: 3, help: "Obtain predictions, residuals, etc. after estimation.\n\n**Syntax:** `predict [type] newvar [if] [in] [, options]`" },
    { cmd: "probit", min: 3, help: "Probit regression.\n\n**Syntax:** `probit depvar [indepvars] [if] [in] [weight] [, options]`" },
    { cmd: "pwcorr", min: 2, help: "Pairwise correlations.\n\n**Syntax:** `pwcorr [varlist] [if] [in] [weight] [, options]`" },
    { cmd: "qreg", min: 2, help: "Quantile regression.\n\n**Syntax:** `qreg depvar [indepvars] [if] [in] [weight] [, options]`" },
    { cmd: "regress", min: 3, help: "Linear regression.\n\n**Syntax:** `regress depvar [indepvars] [if] [in] [weight] [, options]`" },
    { cmd: "summarize", min: 2, help: "Summary statistics.\n\n**Syntax:** `summarize [varlist] [if] [in] [weight] [, options]`" },
    { cmd: "tabstat", min: 4, help: "Compact table of summary statistics.\n\n**Syntax:** `tabstat varlist [if] [in] [weight] [, options]`" },
    { cmd: "tabulate", min: 3, help: "One- and two-way tables of frequencies.\n\n**Syntax:** `tabulate varname1 [varname2] [if] [in] [weight] [, options]`" },
    { cmd: "test", min: 2, help: "Test linear hypotheses after estimation.\n\n**Syntax:** `test coeflist`" },
    { cmd: "tsset", min: 3, help: "Declare data to be time-series data.\n\n**Syntax:** `tsset timevar [, options]`" },
    { cmd: "ttest", min: 2, help: "t tests (mean-comparison tests).\n\n**Syntax:** `ttest varname == #` or `ttest varname1 == varname2`" },
    { cmd: "var", min: 3, help: "Vector autoregressive models.\n\n**Syntax:** `var depvarlist [if] [in] [, options]`" },
    { cmd: "xtreg", min: 3, help: "Fixed-, between-, and random-effects and population-averaged linear models.\n\n**Syntax:** `xtreg depvar [indepvars] [if] [in] [weight] [, fe|re|be|pa options]`" },
    { cmd: "xtset", min: 3, help: "Declare data to be panel data.\n\n**Syntax:** `xtset panelvar timevar [, options]`" },
    { cmd: "assert", min: 3, help: "Verify truth of claim.\n\n**Syntax:** `assert exp [if] [in]`" },
    { cmd: "capture", min: 3, help: "Capture return code.\n\n**Syntax:** `capture command`" },
    { cmd: "continue", min: 4, help: "Break out of loops.\n\n**Syntax:** `continue [, break]`" },
    { cmd: "display", min: 2, help: "Display strings and values of scalar expressions.\n\n**Syntax:** `display [subexpr] [...]`" },
    { cmd: "else", min: 4, help: "Condition execute.\n\n**Syntax:** `else { ... }`" },
    { cmd: "ereturn", min: 3, help: "Post estimation results.\n\n**Syntax:** `ereturn list / post / clear ...`" },
    { cmd: "foreach", min: 4, help: "Loop over items.\n\n**Syntax:** `foreach lname in|of list { ... }`" },
    { cmd: "forvalues", min: 4, help: "Loop over consecutive values.\n\n**Syntax:** `forvalues lname = range { ... }`" },
    { cmd: "if", min: 2, help: "Condition execute.\n\n**Syntax:** `if exp { ... }`" },
    { cmd: "local", min: 3, help: "Define local macro.\n\n**Syntax:** `local lname [=] exp`" },
    { cmd: "global", min: 4, help: "Define global macro.\n\n**Syntax:** `global mname [=] exp`" },
    { cmd: "macro", min: 3, help: "Macro definition and manipulation.\n\n**Syntax:** `macro dir / drop / list ...`" },
    { cmd: "matrix", min: 3, help: "Matrix definition and manipulation.\n\n**Syntax:** `matrix name = ...`" },
    { cmd: "noisily", min: 3, help: "Turn on terminal output.\n\n**Syntax:** `noisily command`" },
    { cmd: "program", min: 4, help: "Define and manipulate programs.\n\n**Syntax:** `program [define] program_name`" },
    { cmd: "quietly", min: 3, help: "Quietly perform command.\n\n**Syntax:** `quietly command`" },
    { cmd: "return", min: 3, help: "Return results.\n\n**Syntax:** `return list / clear / scalar ...`" },
    { cmd: "scalar", min: 4, help: "Scalar variables.\n\n**Syntax:** `scalar scalar_name = exp`" },
    { cmd: "sreturn", min: 3, help: "Return system results.\n\n**Syntax:** `sreturn list / clear / local ...`" },
    { cmd: "syntax", min: 4, help: "Parse Stata syntax.\n\n**Syntax:** `syntax [varlist] [if] [in] [, options]`" },
    { cmd: "while", min: 5, help: "Loop while condition is true.\n\n**Syntax:** `while exp { ... }`" },
    { cmd: "graph", min: 2, help: "The graph command.\n\n**Syntax:** `graph subcommand ...`" },
    { cmd: "histogram", min: 4, help: "Histograms for continuous and categorical variables.\n\n**Syntax:** `histogram varname [if] [in] [weight] [, options]`" },
    { cmd: "kdensity", min: 2, help: "Univariate kernel density estimation.\n\n**Syntax:** `kdensity varname [if] [in] [weight] [, options]`" },
    { cmd: "line", min: 2, help: "Twoway line plots.\n\n**Syntax:** `line yvar xvar [if] [in] [, options]`" },
    { cmd: "scatter", min: 2, help: "Twoway scatterplots.\n\n**Syntax:** `scatter yvar xvar [if] [in] [, options]`" },
    { cmd: "twoway", min: 2, help: "Two-way scatterplots, line plots, etc.\n\n**Syntax:** `twoway plot [if] [in] [, twoway_options]`" },
    { cmd: "cd", min: 2, help: "Change directory.\n\n**Syntax:** `cd [\"\"dir\"\"]`" },
    { cmd: "dir", min: 3, help: "Display filenames.\n\n**Syntax:** `dir [\"\"pattern\"\"]`" },
    { cmd: "do", min: 2, help: "Execute commands from a file.\n\n**Syntax:** `do filename [arguments]`" },
    { cmd: "help", min: 1, help: "Display help in Stata.\n\n**Syntax:** `help command_or_topic`" },
    { cmd: "log", min: 3, help: "Echo copy of session to file.\n\n**Syntax:** `log using filename [, append | replace]`" },
    { cmd: "pwd", min: 3, help: "Display current working directory.\n\n**Syntax:** `pwd`" },
    { cmd: "run", min: 3, help: "Execute commands from a file silently.\n\n**Syntax:** `run filename [arguments]`" },
    { cmd: "search", min: 3, help: "Search Stata documentation and internet.\n\n**Syntax:** `search word [word ...]`" },
    { cmd: "set", min: 3, help: "Set system parameters.\n\n**Syntax:** `set parameter value [, permanently]`" },
    { cmd: "timer", min: 3, help: "Time sections of code.\n\n**Syntax:** `timer on/off/list/clear #`" },
    { cmd: "strpos", min: 4, help: "Find starting position of string 2 in string 1.\n\n**Syntax:** `strpos(s1, s2)`" },
    { cmd: "substr", min: 4, help: "Extract substring starting at n1 for length n2.\n\n**Syntax:** `substr(s, n1, n2)`" },
    { cmd: "subinstr", min: 5, help: "Substitute s2 with s3 in s1, n times.\n\n**Syntax:** `subinstr(s1, s2, s3, n)`" },
    { cmd: "trim", min: 4, help: "Remove leading and trailing spaces.\n\n**Syntax:** `trim(s)`" },
    { cmd: "ltrim", min: 5, help: "Remove leading spaces.\n\n**Syntax:** `ltrim(s)`" },
    { cmd: "rtrim", min: 5, help: "Remove trailing spaces.\n\n**Syntax:** `rtrim(s)`" },
    { cmd: "itrim", min: 5, help: "Replace consecutive internal spaces with a single space.\n\n**Syntax:** `itrim(s)`" },
    { cmd: "ustrlower", min: 6, help: "Convert Unicode string to lowercase.\n\n**Syntax:** `ustrlower(s)`" },
    { cmd: "ustrupper", min: 6, help: "Convert Unicode string to uppercase.\n\n**Syntax:** `ustrupper(s)`" },
    { cmd: "ustrtitle", min: 6, help: "Convert Unicode string to titlecase.\n\n**Syntax:** `ustrtitle(s)`" },
    { cmd: "strlen", min: 5, help: "Length of string in bytes.\n\n**Syntax:** `strlen(s)`" },
    { cmd: "ustrlen", min: 6, help: "Length of Unicode string in characters.\n\n**Syntax:** `ustrlen(s)`" },
    { cmd: "regexm", min: 5, help: "Perform regular expression match.\n\n**Syntax:** `regexm(s, re)`" },
    { cmd: "regexr", min: 5, help: "Perform regular expression replacement.\n\n**Syntax:** `regexr(s1, re, s2)`" },
    { cmd: "regexs", min: 5, help: "Extract subexpression matched by regexm.\n\n**Syntax:** `regexs(n)`" },
    { cmd: "word", min: 4, help: "Extract nth word from a string.\n\n**Syntax:** `word(s, n)`" },
    { cmd: "wordcount", min: 5, help: "Count number of words in a string.\n\n**Syntax:** `wordcount(s)`" }
];

const stataCommandOptions = {
    summarize: [
        { name: "detail", help: "Display additional statistics (percentiles, variance, skewness, kurtosis)." },
        { name: "meanonly", help: "Calculate only the mean and count; fastest for macros." },
        { name: "format", help: "Use variable display formats." },
        { name: "separator()", snippet: "separator(${1:10})", help: "Draw separator line every n variables." }
    ],
    regress: [
        { name: "robust", help: "Calculate Huber/White/sandwich robust standard errors." },
        { name: "vce()", snippet: "vce(${1|robust,cluster,hc2,hc3|})", help: "Specify variance-covariance estimator type." },
        { name: "level()", snippet: "level(${1:95})", help: "Set confidence level %." },
        { name: "nocons", help: "Suppress constant term." }
    ],
    tabulate: [
        { name: "missing", help: "Treat missing values as categories." },
        { name: "nolabel", help: "Display numeric codes rather than value labels." },
        { name: "generate()", snippet: "generate(${1:stub})", help: "Create indicator variables for categories." },
        { name: "sort", help: "Display rows in descending order of frequency." }
    ],
    keep: [], drop: [], sort: [],
    order: [
        { name: "first", help: "Move variables to beginning of dataset." },
        { name: "last", help: "Move variables to end of dataset." },
        { name: "before()", snippet: "before(${1:varname})", help: "Move variables before specified variable." },
        { name: "after()", snippet: "after(${1:varname})", help: "Move variables after specified variable." }
    ]
};

class StataCompletionProvider {
    constructor(vProvider, sProvider) {
        this.variablesProvider = vProvider;
        this.storedProvider = sProvider;
    }

    provideCompletionItems(document, position) {
        const linePrefix = document.lineAt(position).text.substr(0, position.character);

        const macroMatch = linePrefix.match(/([`\$])([a-zA-Z0-9_]*)$/);
        if (macroMatch) {
            const prefixChar = macroMatch[1];
            if (prefixChar === '`') {
                const locals = new Set();
                const localRegex = /(?:local\s+([a-zA-Z0-9_]+))|(?:foreach\s+([a-zA-Z0-9_]+)\s+in)|(?:forvalues\s+([a-zA-Z0-9_]+)\s*=)/g;
                const text = document.getText();
                let m;
                while ((m = localRegex.exec(text)) !== null) {
                    const localName = m[1] || m[2] || m[3];
                    if (localName) locals.add(localName);
                }
                return Array.from(locals).map(l => {
                    const item = new vscode.CompletionItem(l, vscode.CompletionItemKind.Variable);
                    item.detail = "Local Macro";
                    return item;
                });
            }

            if (prefixChar === '$') {
                const globals = this.storedProvider.results.g || {};
                return Object.entries(globals).map(([k, v]) => {
                    const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Constant);
                    item.detail = `Global: ${v}`;
                    return item;
                });
            }
        }

        const resolveRootCommand = () => {
            let currentLineIdx = position.line;
            let fullCommandText = linePrefix;

            while (currentLineIdx > 0) {
                const prevLine = document.lineAt(currentLineIdx - 1).text.trim();
                if (prevLine.endsWith('///')) {
                    fullCommandText = prevLine.replace(/Threshold|\/\/\/*$/, '').trim() + " " + fullCommandText;
                    currentLineIdx--;
                } else {
                    break;
                }
            }

            const cleaned = fullCommandText
                .replace(/^\s*(?:by\s+[^:]+:|bysort\s+[^:]+:|quietly|qui|noisily|noi|capture|cap)\s*/gi, '')
                .trim();

            const match = cleaned.match(/^([a-zA-Z0-9_]+)/);
            return match ? match[1].toLowerCase() : null;
        };

        const commaIndex = linePrefix.indexOf(',');
        if (commaIndex !== -1 && commaIndex < position.character) {
            const rootCmd = resolveRootCommand();
            if (rootCmd) {
                const matchedCmdKey = Object.keys(stataCommandOptions).find(k => {
                    const docMatch = stataHelpDocs.find(d => d.cmd === k);
                    return k === rootCmd || (docMatch && rootCmd.length >= docMatch.min && d.cmd.startsWith(rootCmd));
                });

                if (matchedCmdKey && stataCommandOptions[matchedCmdKey]) {
                    return stataCommandOptions[matchedCmdKey].map(opt => {
                        const item = new vscode.CompletionItem(opt.name, vscode.CompletionItemKind.Property);
                        item.detail = `Option for ${matchedCmdKey}`;
                        item.documentation = new vscode.MarkdownString(opt.help);

                        if (opt.snippet) {
                            item.insertText = new vscode.SnippetString(opt.snippet);
                        }
                        return item;
                    });
                }
            }
        }

        const rootCmd = resolveRootCommand();
        const dataCmdRegex = /^(summarize|sum|regress|reg|tabulate|tab|keep|drop|sort|order|codebook|inspect)$/i;
        const isDataCmdContext = rootCmd && dataCmdRegex.test(rootCmd);

        const varItems = this.variablesProvider.variables.map(v => {
            const item = new vscode.CompletionItem(v.name, vscode.CompletionItemKind.Field);
            item.detail = `[${v.type}] ${v.label}`;
            item.documentation = `Format: ${v.format}`;
            if (isDataCmdContext) {
                item.sortText = `0_${v.name}`;
                item.preselect = true;
            } else {
                item.sortText = `1_${v.name}`;
            }
            return item;
        });

        const cmdItems = stataHelpDocs.map(d => {
            const item = new vscode.CompletionItem(d.cmd, vscode.CompletionItemKind.Function);
            item.detail = "Stata Command";
            item.documentation = new vscode.MarkdownString(d.help);
            item.sortText = `2_${d.cmd}`;
            return item;
        });

        return varItems.concat(cmdItems);
    }
}

class StataHoverProvider {
    constructor(vProvider, sProvider) {
        this.variablesProvider = vProvider;
        this.storedProvider = sProvider;
    }

    async provideHover(document, position) {
        const range = document.getWordRangeAtPosition(position, /[`\$]?[a-zA-Z0-9_]+'?/);
        if (!range) return null;

        const word = document.getText(range);
        const wordLower = word.toLowerCase();

        if (word.startsWith('$')) {
            const macroName = word.substring(1);
            const val = this.storedProvider.results.g && this.storedProvider.results.g[macroName];
            const md = new vscode.MarkdownString();
            if (val !== undefined) {
                md.appendMarkdown(`**🌐 Active Global Macro: \`${word}\`**\n\nCurrent Memory Value:\n\`\`\`stata\n${val}\n\`\`\``);
            } else {
                md.appendMarkdown(`**🌐 Global Macro: \`${word}\`**\n\n*Not currently defined in memory.*`);
            }
            return new vscode.Hover(md, range);
        }

        if (word.startsWith('`') && word.endsWith("'")) {
            const macroName = word.substring(1, word.length - 1);
            let defLine = "*Definition not found in current file.*";
            for (let i = position.line; i >= 0; i--) {
                const lineText = document.lineAt(i).text;
                const localRegex = new RegExp(`(?:local\\s+${macroName}\\b)|(?:foreach\\s+${macroName}\\b)|(?:forvalues\\s+${macroName}\\b)`);
                if (localRegex.test(lineText)) {
                    defLine = lineText.trim();
                    let j = i;
                    while (defLine.endsWith('///') && j < document.lineCount - 1) {
                        j++;
                        const nextLine = document.lineAt(j).text;
                        defLine += "\n" + nextLine.trimStart();
                        if (!nextLine.trim().endsWith('///')) break;
                    }
                    defLine = defLine.trim();
                    break;
                }
            }
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**🔒 Local Macro: \`${word}\`**\n\nFound definition context:\n\`\`\`stata\n${defLine}\n\`\`\``);
            return new vscode.Hover(md, range);
        }

        const variable = this.variablesProvider.variables.find(v => v.name === word);
        if (variable) {
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**Variable:** \`${variable.name}\`  \n`);
            md.appendMarkdown(`**Label:** ${variable.label || '*none*'}  \n`);
            md.appendMarkdown(`**Type:** ${variable.type} | **Format:** ${variable.format}\n\n`);

            const isNumeric = variable.type.toLowerCase().includes('num') || !variable.type.toLowerCase().startsWith('str');

            if (!isEngineBusy) {
                try {
                    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500));
                    const response = await Promise.race([
                        sendToBackend({ cmd: 'hover_summary', var_name: variable.name }),
                        timeoutPromise
                    ]);

                    if (response.data && !response.data.error) {
                        const r = response.data;
                        md.appendMarkdown(`---\n**📊 Live Memory Profile**\n\n`);

                        // Inject the dynamically generated SVG
                        if (r.svg) {
                            md.appendMarkdown(`![Distribution](data:image/svg+xml;base64,${r.svg})  \n\n`);
                        }

                        if (r.type === 'string') {
                            md.appendMarkdown(`| Metric | Value |\n|---|---|\n`);
                            md.appendMarkdown(`| Unique | **${r.unique}** |\n`);
                            md.appendMarkdown(`| Missing | **${r.missing}** |\n`);
                            if (r.top && r.top.length > 0) {
                                md.appendMarkdown(`| Mode | **${r.top[0].val}** (${Math.round(r.top[0].pct)}%) |\n`);
                            }
                        } else {
                            const badges = [];
                            if (r.has_neg) badges.push('`[<0]`');
                            if (r.has_zero) badges.push('`[0]`');
                            const badgeStr = badges.length > 0 ? ' ' + badges.join(' ') : '';

                            md.appendMarkdown(`| Statistic | Value | Statistic | Value |\n|---|---|---|---|\n`);
                            if (r.type === 'date') {
                                md.appendMarkdown(`| Missing | **${r.missing}** | Median | **${r.median}** |\n`);
                            } else {
                                md.appendMarkdown(`| Mean | **${r.mean}** | Median | **${r.median}** |\n`);
                            }
                            md.appendMarkdown(`| Min | **${r.min}**${badgeStr} | Max | **${r.max}** |\n`);
                        }
                    }
                } catch (e) {
                    md.appendMarkdown(`---\n*Engine busy or fetch timed out.*\n`);
                }
            } else {
                md.appendMarkdown(`---\n*Engine busy. Live stats unavailable.*\n`);
            }
            return new vscode.Hover(md, range);
        }

        const progRegex = new RegExp(`^\\s*program\\s+(?:define\\s+)?${word}\\b`);
        let progLine = -1;
        for (let i = 0; i < document.lineCount; i++) {
            if (progRegex.test(document.lineAt(i).text)) {
                progLine = i;
                break;
            }
        }

        if (progLine !== -1) {
            let docLines = [];
            for (let i = progLine - 1; i >= Math.max(0, progLine - 10); i--) {
                const text = document.lineAt(i).text.trim();
                if (text.startsWith('*!') || text.startsWith('*') || text.startsWith('//')) {
                    docLines.unshift(text.replace(/^(\*!|\*|\/\/)\s*/, ''));
                } else if (text === '') {
                    continue;
                } else {
                    break;
                }
            }
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**🛠️ Custom Program:** \`${word}\`\n\n`);
            if (docLines.length > 0) {
                md.appendMarkdown(`*${docLines.join('  \n')}*`);
            } else {
                md.appendMarkdown(`*(No documentation comments found above definition)*`);
            }
            return new vscode.Hover(md, range);
        }

        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        const docMatch = stataHelpDocs.find(d => wordLower.length >= d.min && d.cmd.startsWith(wordLower));

        if (docMatch) {
            md.appendMarkdown(`**${docMatch.cmd.toUpperCase()}**\n\n${docMatch.help}\n\n`);
        } else {
            md.appendMarkdown(`**${wordLower}**\n\n`);
        }
        md.appendMarkdown(`--- \n\n[▶ View native Stata help for '${wordLower}'](command:stata-ide.help?${encodeURIComponent(JSON.stringify(wordLower))})`);
        return new vscode.Hover(md, range);
    }
}

class StataRenameProvider {
    provideRenameEdits(document, position, newName, token) {
        const range = document.getWordRangeAtPosition(position);
        if (!range) return null;

        const oldName = document.getText(range);
        if (oldName === newName) return null;

        const workspaceEdit = new vscode.WorkspaceEdit();
        let inBlockComment = false;

        for (let lineIdx = 0; lineIdx < document.lineCount; lineIdx++) {
            const lineText = document.lineAt(lineIdx).text;
            if (!inBlockComment && /^\s*\*/.test(lineText)) continue;

            let inString = false;
            let inCompoundString = false;
            let charIdx = 0;

            while (charIdx < lineText.length) {
                if (inBlockComment) {
                    if (lineText.substring(charIdx, charIdx + 2) === '*/') {
                        inBlockComment = false;
                        charIdx += 2;
                    } else charIdx++;
                    continue;
                }
                if (inCompoundString) {
                    if (lineText.substring(charIdx, charIdx + 2) === '"\'') {
                        inCompoundString = false;
                        charIdx += 2;
                    } else charIdx++;
                    continue;
                }
                if (inString) {
                    if (lineText[charIdx] === '"') inString = false;
                    charIdx++;
                    continue;
                }
                if (lineText.substring(charIdx, charIdx + 2) === '/*') {
                    inBlockComment = true;
                    charIdx += 2;
                    continue;
                }
                if (lineText.substring(charIdx, charIdx + 2) === '//') break;
                if (lineText.substring(charIdx, charIdx + 2) === '`"') {
                    inCompoundString = true;
                    charIdx += 2;
                    continue;
                }
                if (lineText[charIdx] === '"') {
                    inString = true;
                    charIdx++;
                    continue;
                }

                if (lineText.startsWith(oldName, charIdx)) {
                    const before = charIdx === 0 ? ' ' : lineText[charIdx - 1];
                    const after = charIdx + oldName.length >= lineText.length ? ' ' : lineText[charIdx + oldName.length];
                    const isWordChar = (c) => /[a-zA-Z0-9_]/.test(c);

                    if (!isWordChar(before) && !isWordChar(after)) {
                        const editRange = new vscode.Range(lineIdx, charIdx, lineIdx, charIdx + oldName.length);
                        workspaceEdit.replace(document.uri, editRange, newName);
                        charIdx += oldName.length;
                        continue;
                    }
                }
                charIdx++;
            }
        }
        return workspaceEdit;
    }
}

class StataDefinitionProvider {
    async provideDefinition(document, position, token) {
        const range = document.getWordRangeAtPosition(position);
        if (!range) return null;
        const word = document.getText(range);

        const progRegex = new RegExp(`^\\s*program\\s+(?:define\\s+)?${word}\\b`);
        for (let i = 0; i < document.lineCount; i++) {
            if (progRegex.test(document.lineAt(i).text)) {
                return new vscode.Location(document.uri, new vscode.Position(i, 0));
            }
        }

        if (!isEngineBusy) {
            try {
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500));
                const response = await Promise.race([
                    sendToBackend({ cmd: 'find_ado', program_name: word }),
                    timeoutPromise
                ]);
                if (response && response.data) {
                    const adoPath = response.data.replace(/\\/g, '/');
                    return new vscode.Location(vscode.Uri.file(adoPath), new vscode.Position(0, 0));
                }
            } catch (e) { }
        }
        return null;
    }
}

class StataDocumentFormattingEditProvider {
    provideDocumentFormattingEdits(document, options, token) {
        const edits = [];
        let indentLevel = 0;
        let isContinuation = false;
        const tabSize = options.tabSize;
        const indentStr = options.insertSpaces ? ' '.repeat(tabSize) : '\t';

        const applyKeywordTabAlignment = (str) => {
            const match = str.match(/^(gen|generate|egen|replace|local|global)\b\s*(.*)$/i);
            if (match) {
                const kw = match[1];
                const rest = match[2];
                const targetPadding = tabSize - (kw.length % tabSize);
                return kw + ' '.repeat(targetPadding) + rest;
            }
            return str;
        };

        const findAssignmentEquals = (str) => {
            let inString = false;
            for (let k = 0; k < str.length; k++) {
                if (str[k] === '"') inString = !inString;
                else if (!inString && str[k] === '=') {
                    if (k > 0 && ['=', '!', '<', '>'].includes(str[k - 1])) continue;
                    if (k < str.length - 1 && str[k + 1] === '=') continue;
                    return k;
                }
            }
            return -1;
        };

        const normalizeLine = (str) => {
            if (/^\s*ren(ame)?\b/i.test(str)) return str.trim();
            let result = "";
            const parts = str.split('"');
            for (let k = 0; k < parts.length; k++) {
                if (k % 2 === 0) {
                    let p = parts[k]
                        .replace(/\s*(==|!=|<=|>=|<|>|=)\s*/g, ' $1 ')
                        .replace(/\s*,\s*/g, ', ')
                        .replace(/\s+/g, ' ');
                    result += p;
                } else {
                    result += '"' + parts[k] + '"';
                }
            }
            return result.trim();
        };

        let i = 0;
        while (i < document.lineCount) {
            const line = document.lineAt(i);
            let text = line.text.trim();

            if (text.length === 0) {
                i++;
                continue;
            }

            if (text.startsWith('*') || text.startsWith('//') || text.startsWith('/*')) {
                i++;
                continue;
            }

            const hasContinuationEnd = text.endsWith('///');
            let mainCode = hasContinuationEnd ? text.slice(0, -3).trim() : text;

            if (mainCode.startsWith('}') || /^\s*restore\b/i.test(mainCode)) {
                indentLevel = Math.max(0, indentLevel - 1);
            }

            mainCode = normalizeLine(mainCode);

            const isAssignLine = (str) => /^\s*(?:gen|generate|egen|replace|local|global)\b/i.test(str) && findAssignmentEquals(str) !== -1;

            if (isAssignLine(mainCode)) {
                let blockEnd = i;
                let maxEqualPos = 0;

                for (let j = i; j < document.lineCount; j++) {
                    let candidateText = document.lineAt(j).text.trim();
                    if (candidateText.startsWith('*') || candidateText.startsWith('//') || candidateText.startsWith('/*')) {
                        break;
                    }

                    let cHasTriple = candidateText.endsWith('///');
                    let cCode = cHasTriple ? candidateText.slice(0, -3).trim() : candidateText;

                    if (isAssignLine(cCode)) {
                        blockEnd = j;
                        cCode = normalizeLine(cCode);
                        cCode = applyKeywordTabAlignment(cCode);
                        const eqIdx = findAssignmentEquals(cCode);
                        if (eqIdx !== -1) {
                            const prefixLen = cCode.substring(0, eqIdx).trimEnd().length;
                            maxEqualPos = Math.max(maxEqualPos, prefixLen);
                        }
                    } else {
                        break;
                    }
                }

                for (let j = i; j <= blockEnd; j++) {
                    const currLine = document.lineAt(j);
                    let currText = currLine.text.trim();

                    const lineHasTripleSlash = currText.endsWith('///');
                    if (lineHasTripleSlash) currText = currText.slice(0, -3).trim();

                    currText = normalizeLine(currText);
                    currText = applyKeywordTabAlignment(currText);

                    const eqIdx = findAssignmentEquals(currText);
                    if (eqIdx !== -1) {
                        const lhs = currText.substring(0, eqIdx).trimEnd();
                        const rhs = currText.substring(eqIdx + 1).trim();

                        const paddedLhs = lhs.padEnd(maxEqualPos, ' ');
                        const currentLevel = indentLevel + (isContinuation ? 1 : 0);
                        const desiredIndent = indentStr.repeat(currentLevel);

                        let formattedLine = `${desiredIndent}${paddedLhs} = ${rhs}`;
                        if (lineHasTripleSlash) {
                            formattedLine += ' ///';
                        }

                        if (currLine.text !== formattedLine) {
                            edits.push(vscode.TextEdit.replace(currLine.range, formattedLine));
                        }
                    }

                    isContinuation = lineHasTripleSlash;
                    if (currText.endsWith('{') || /^\s*preserve\b/i.test(currText)) {
                        indentLevel++;
                    }
                }

                i = blockEnd + 1;
                continue;
            }

            mainCode = applyKeywordTabAlignment(mainCode);

            if (mainCode.length > 100 && /^\s*(twoway|graph|scatter|line|histogram)\b/i.test(mainCode)) {
                const parts = mainCode.split('||');
                if (parts.length > 1) {
                    const desiredIndent = indentStr.repeat(indentLevel + (isContinuation ? 1 : 0));
                    const continuationIndent = indentStr.repeat(indentLevel + 1);

                    const wrappedText = parts.map((part, idx) => {
                        const trimmedPart = part.trim();
                        const currentIndent = (idx === 0) ? desiredIndent : continuationIndent;
                        if (idx < parts.length - 1) {
                            return `${currentIndent}${trimmedPart} || ///`;
                        }
                        return `${currentIndent}${trimmedPart}`;
                    }).join('\n');

                    edits.push(vscode.TextEdit.replace(line.range, wrappedText));
                    isContinuation = true;
                    if (mainCode.endsWith('{') || /^\s*preserve\b/i.test(mainCode)) {
                        indentLevel++;
                    }
                    i++;
                    continue;
                }
            }

            const currentIndentLevel = indentLevel + (isContinuation ? 1 : 0);
            const desiredIndent = indentStr.repeat(currentIndentLevel);

            let fullFormattedLine = `${desiredIndent}${mainCode}`;
            if (hasContinuationEnd) {
                fullFormattedLine += ' ///';
            }

            if (line.text !== fullFormattedLine) {
                edits.push(vscode.TextEdit.replace(line.range, fullFormattedLine));
            }

            isContinuation = hasContinuationEnd;
            if (mainCode.endsWith('{') || /^\s*preserve\b/i.test(mainCode)) {
                indentLevel++;
            }

            i++;
        }

        return edits;
    }
}

class StataDocumentSymbolProvider {
    provideDocumentSymbols(document, token) {
        const symbols = [];
        let currentProgramSymbol = null;

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const text = line.text;

            const bookmarkMatch = text.match(/^\s*\*\*\#\s*(.*)$/);
            if (bookmarkMatch) {
                const name = bookmarkMatch[1].trim() || "Bookmark";
                const symbol = new vscode.DocumentSymbol(
                    name,
                    'Section',
                    vscode.SymbolKind.String,
                    line.range,
                    line.range
                );
                if (currentProgramSymbol) {
                    currentProgramSymbol.children.push(symbol);
                } else {
                    symbols.push(symbol);
                }
                continue;
            }

            const progMatch = text.match(/^\s*program\s+(?:define\s+)?([a-zA-Z0-9_]+)\b/i);
            if (progMatch) {
                const progName = progMatch[1];
                currentProgramSymbol = new vscode.DocumentSymbol(
                    progName,
                    'Program Block',
                    vscode.SymbolKind.Function,
                    line.range,
                    line.range
                );
                symbols.push(currentProgramSymbol);
                continue;
            }

            if (currentProgramSymbol && /^\s*end\b/i.test(text)) {
                currentProgramSymbol.range = new vscode.Range(
                    currentProgramSymbol.range.start,
                    line.range.end
                );
                currentProgramSymbol = null;
            }
        }
        return symbols;
    }
}

// ============================================================================
// IPC ENGINE & BACKEND
// ============================================================================
function sendToBackend(payload) {
    return new Promise((resolve, reject) => {
        requestIdCounter++;
        payload.req_id = requestIdCounter;
        pendingRequests.set(requestIdCounter, { resolve, reject });
        if (stataProcess && stataProcess.stdin) {
            stataProcess.stdin.write(JSON.stringify(payload) + '\n');
        } else {
            reject(new Error("Stata process not running"));
        }
    });
}

function initializeBackend(context) {
    const config = vscode.workspace.getConfiguration('stata-ide');
    const pythonPath = config.get('pythonPath') || 'python';
    const stataPath = config.get('stataPath') || '';

    const scriptPath = path.join(context.extensionPath, 'backend', 'stata_server.py');
    const args = [scriptPath];
    if (stataPath) args.push('--stata-path', stataPath);

    const env = Object.assign({}, process.env, { PYTHONUNBUFFERED: "1" });
    stataProcess = spawn(pythonPath, args, { env });

    stataProcess.on('error', (err) => {
        if (statusBarItem) statusBarItem.text = '$(error) Stata: Error';
        vscode.window.showErrorMessage(`Failed to initialize Stata Backend: ${err.message}. Is Python installed and configured correctly?`);
    });

    let stdoutBuffer = "";

    stataProcess.stdout.on('data', (data) => {
        stdoutBuffer += data.toString();
        let newlineIdx;

        while ((newlineIdx = stdoutBuffer.indexOf('\n')) > -1) {
            const line = stdoutBuffer.substring(0, newlineIdx);
            stdoutBuffer = stdoutBuffer.substring(newlineIdx + 1);

            if (!line.trim()) continue;

            try {
                const parsed = JSON.parse(line);

                if (parsed.req_id && pendingRequests.has(parsed.req_id)) {
                    const { resolve } = pendingRequests.get(parsed.req_id);
                    resolve(parsed);
                    pendingRequests.delete(parsed.req_id);
                }

                if (parsed.type === 'status') {
                    if (statusBarItem) {
                        if (parsed.data === 'idle') {
                            isEngineBusy = false;
                            statusBarItem.text = '$(check) Stata: Ready';
                            statusBarItem.command = null;
                        } else {
                            isEngineBusy = true;
                            statusBarItem.text = '$(sync~spin) Stata: Running';
                            statusBarItem.command = 'stata-ide.stopExecution';
                        }
                    }
                } else if (parsed.type === 'hover_summary_result') continue;
                else if (parsed.type === 'output') {
                    if (parsed.data.includes('[Stata Error]:')) {
                        resultsProvider.appendError(parsed.data);
                    } else {
                        resultsProvider.appendOutput(parsed.data);
                    }
                } else if (parsed.type === 'variables') {
                    if (typeof activeVariablesSubset !== 'undefined' && activeVariablesSubset.length > 0) {
                        const newVarNames = new Set(parsed.data.map(v => v.name));
                        activeVariablesSubset = activeVariablesSubset.filter(v => newVarNames.has(v));
                    }
                    variablesProvider.refresh(parsed.data);
                    try {
                        if (vscode.window.activeTextEditor) {
                            lintStataDocument(vscode.window.activeTextEditor.document, variablesProvider);
                        }
                    } catch (err) { }
                } else if (parsed.type === 'execution_finished') {
                    if (!activeDatasetPanel) {
                        vscode.commands.executeCommand('stata-ide.viewActiveDataset');
                    } else {
                        activeDatasetWebview.postMessage({ type: 'resetData' });
                        sendToBackend({
                            cmd: 'fetch_active',
                            start: 0,
                            end: 200,
                            variables: activeVariablesSubset,
                            rowFilter: activeRowFilter
                        }).catch(() => { });
                    }
                } else if (parsed.type === 'stored_results') {
                    storedResultsProvider.refresh(parsed.data);
                } else if (parsed.type === 'open_viewer') {
                    if (parsed.variables && parsed.variables.length > 0) {
                        activeVariablesSubset = parsed.variables;
                    } else {
                        activeVariablesSubset = [];
                    }
                    if (activeDatasetPanel) {
                        activeDatasetWebview.postMessage({ type: 'resetData' });
                        sendToBackend({
                            cmd: 'fetch_active',
                            start: 0,
                            end: 200,
                            variables: activeVariablesSubset,
                            rowFilter: activeRowFilter
                        }).catch(() => {});
                    }
                    vscode.commands.executeCommand('stata-ide.viewActiveDataset');
                } else if (parsed.type === 'graph') {
                    showGraphWebview(parsed.data, context);
                } else if (parsed.type === 'column_stats_result' && activeDatasetWebview) {
                    activeDatasetWebview.postMessage(parsed);
                } else if (parsed.type === 'dataChunk' && activeDatasetWebview) {
                    activeDatasetWebview.postMessage({
                        type: 'chunkData',
                        data: parsed.data || [],
                        total: parsed.total || 0,
                        columns: parsed.columns || [],
                        req_start: parsed.req_start,
                        frozenVars: Array.from(variablesProvider.frozenVars)
                    });
                } else if (parsed.type === 'filter_validation' && activeDatasetWebview) {
                    activeDatasetWebview.postMessage(parsed);
                } else if (parsed.type === 'error') {
                    historyProvider.markLastError();
                    resultsProvider.appendError(`\n[Stata Error]: ${parsed.data}\n`);
                }
            } catch (e) {
                console.error("Failed to parse IPC message chunk:", e);
            }
        }
    });

    stataProcess.stderr.on('data', (data) => {
        console.error(`Backend stderr: ${data.toString()}`);
        if (resultsProvider) {
            resultsProvider.appendError(`\n[Backend Crash Log]: ${data.toString()}\n`);
        }
    });

    stataProcess.on('exit', (code, signal) => {
        if (statusBarItem) statusBarItem.text = '$(error) Stata: Offline';
        if (stataProcess.killed || signal === 'SIGTERM' || signal === 'SIGKILL') {
            return;
        }
        vscode.window.showErrorMessage("Stata Backend process exited unexpectedly.", "Restart Engine").then(choice => {
            if (choice === "Restart Engine") initializeBackend(context);
        });
    });

    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
        sendToBackend({ cmd: "ping" }).catch(() => { });
    }, 10000);
}

// ============================================================================
// WEBVIEW HTML GENERATORS 
// ============================================================================
async function showGraphWebview(imagePath, context) {
    let base64Image;
    try {
        const imageBuffer = fs.readFileSync(imagePath);
        base64Image = imageBuffer.toString('base64');
    } catch (err) {
        return;
    }

    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const imgSrc = `data:image/svg+xml;base64,${base64Image}`;

    plotHistory.unshift({ src: imgSrc, time: timestamp });

    if (!graphWebviewPanel) {
        let targetColumn = vscode.ViewColumn.Beside;
        if (activeDatasetPanel) {
            try {
                const col = activeDatasetPanel.viewColumn || vscode.ViewColumn.Beside;
                activeDatasetPanel.reveal(col, false);
                await new Promise(resolve => setTimeout(resolve, 150));
                await vscode.commands.executeCommand('workbench.action.splitEditorDown');
                targetColumn = vscode.ViewColumn.Active;
            } catch (e) { targetColumn = vscode.ViewColumn.Beside; }
        }

        const resourcesFolder = path.join(context.extensionPath, 'resources');
        graphWebviewPanel = vscode.window.createWebviewPanel(
            'stataGraph', 'Stata Plot Gallery', targetColumn,
            { enableScripts: true, localResourceRoots: [vscode.Uri.file(resourcesFolder)] }
        );

        const chartIconUri = vscode.Uri.file(path.join(resourcesFolder, 'chart-file.svg'));
        graphWebviewPanel.iconPath = { light: chartIconUri, dark: chartIconUri };

        graphWebviewPanel.onDidDispose(() => { graphWebviewPanel = null; });

        graphWebviewPanel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'savePlot') {
                const uri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(`stata_plot_${Date.now()}.svg`),
                    filters: { 'Images': ['svg'] }
                });

                if (uri) {
                    const base64Data = msg.data.replace(/^data:image\/svg\+xml;base64,/, "");
                    fs.writeFileSync(uri.fsPath, Buffer.from(base64Data, 'base64'));
                    vscode.window.showInformationMessage(`Plot saved successfully!`);
                }
            } else if (msg.command === 'clearPlots') {
                plotHistory = [];
            }
        });

        graphWebviewPanel.webview.html = getGraphGalleryHtml(plotHistory);
    } else {
        graphWebviewPanel.webview.postMessage({ type: 'updatePlots', plots: plotHistory });
    }
    graphWebviewPanel.reveal(graphWebviewPanel.viewColumn || vscode.ViewColumn.Active, true);
}

function getGraphGalleryHtml(initialPlots) {
    const plotsJson = JSON.stringify(initialPlots);
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: vscode-resource:; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
        <style>
            body { margin: 0; padding: 15px; background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
            .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 15px; position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 10; }
            h3 { margin: 0; font-weight: 600; font-size: 14px; }
            .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 2px; font-size: 12px; }
            .btn:hover { background: var(--vscode-button-hoverBackground); }
            .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
            .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
            .plot-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 25px; padding: 15px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
            .plot-header { display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 12px; opacity: 0.7; font-weight: bold; }
            .plot-img { max-width: 100%; height: auto; display: block; margin: 0 auto; background: white; border-radius: 2px; }
            .actions { display: flex; justify-content: flex-end; margin-top: 15px; }
            #empty-state { text-align: center; margin-top: 80px; opacity: 0.5; font-style: italic; }
        </style>
    </head>
    <body>
        <div class="header">
            <h3>📊 Session Plot Gallery</h3>
            <button class="btn btn-secondary" id="clear-btn">Clear History</button>
        </div>
        <div id="gallery"></div>
        <script>
            const vscode = acquireVsCodeApi();
            const gallery = document.getElementById('gallery');
            let currentPlots = ${plotsJson};
            
            function renderPlots() {
                if (currentPlots.length === 0) {
                    gallery.innerHTML = '<div id="empty-state">No graphs generated in this session yet.</div>';
                    return;
                }
                gallery.innerHTML = '';
                currentPlots.forEach((p, idx) => {
                    const card = document.createElement('div');
                    card.className = 'plot-card';
                    card.innerHTML = \`
                        <div class="plot-header">
                            <span>Plot \${currentPlots.length - idx}</span>
                            <span>\${p.time}</span>
                        </div>
                        <img class="plot-img" src="\${p.src}" alt="Stata Plot" />
                        <div class="actions">
                            <button class="btn save-btn" data-idx="\${idx}">Save As...</button>
                        </div>
                    \`;
                    gallery.appendChild(card);
                });
                document.querySelectorAll('.save-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const idx = e.target.getAttribute('data-idx');
                        vscode.postMessage({ command: 'savePlot', data: currentPlots[idx].src });
                    });
                });
            }
            document.getElementById('clear-btn').addEventListener('click', () => {
                currentPlots = [];
                renderPlots();
                vscode.postMessage({ command: 'clearPlots' });
            });
            window.addEventListener('message', event => {
                if (event.data.type === 'updatePlots') {
                    currentPlots = event.data.plots;
                    renderPlots();
                }
            });
            renderPlots();
        </script>
    </body>
    </html>
    `;
}

function getGridHtml(fetchCommandName) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            html, body { margin: 0; padding: 0; background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: monospace; height: 100%; overflow: hidden; display: flex; flex-direction: column; }
            
            #stats-bar { 
                flex: 0 0 auto; padding: 8px 12px; font-weight: bold; 
                background-color: var(--vscode-editor-background); 
                border-bottom: 1px solid var(--vscode-panel-border); 
                z-index: 10; font-size: 13px; 
                display: flex; flex-direction: column; gap: 8px;
            }
            .top-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
            #stats-text { white-space: nowrap; }
            
            .filter-toolbar { display: flex; gap: 8px; width: 100%; align-items: center; }
            .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 8px; cursor: pointer; border-radius: 2px; font-size: 12px; white-space: nowrap; }
            .btn:hover { background: var(--vscode-button-hoverBackground); }
            .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
            .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
            
            #raw-filter-container { display: flex; flex: 1; }
            #row-filter { 
                flex: 1; padding: 4px 6px; 
                background: var(--vscode-input-background); color: var(--vscode-input-foreground); 
                border: 1px solid var(--vscode-input-border); font-family: monospace; 
                min-width: 100px; resize: none; overflow-y: auto; box-sizing: border-box; line-height: 1.4; min-height: 30px; max-height: 120px; border-radius: 2px;
            }
            #row-filter:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
            
            #visual-builder-container { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; overflow-x: auto; font-family: var(--vscode-font-family); display: none; }
            .query-group { border-left: 2px solid var(--vscode-focusBorder); padding-left: 12px; margin-top: 8px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 6px; }
            .query-rule { display: flex; gap: 6px; align-items: center; }
            .query-select, .query-input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 3px 6px; font-family: inherit; font-size: 12px; }
            .query-btn { background: transparent; color: var(--vscode-button-foreground); border: 1px solid var(--vscode-panel-border); cursor: pointer; padding: 2px 6px; font-size: 11px; }
            .query-btn:hover { background: var(--vscode-list-hoverBackground); }
            .query-btn.danger:hover { background: var(--vscode-errorForeground); color: white; border-color: var(--vscode-errorForeground); }

            #grid-wrapper { flex: 1 1 auto; position: relative; overflow: auto; background-color: var(--vscode-editor-background); }
            #scroll-sizer { position: absolute; top: 0; left: 0; width: 1px; z-index: -1; }
            
            table { border-collapse: collapse; table-layout: fixed; position: absolute; top: 0; left: 0; background-color: var(--vscode-editor-background); }
            th, td { 
                padding: 4px 8px; text-align: left; white-space: nowrap; 
                border-bottom: 1px solid var(--vscode-panel-border); border-right: 1px solid var(--vscode-panel-border); 
                overflow: hidden; text-overflow: ellipsis; box-sizing: border-box;
            }
            table.show-stats th { height: 100px; vertical-align: top; }
            td.num-cell { text-align: right; }
            
            th { 
                position: sticky; top: 0; background-color: var(--vscode-editor-background); z-index: 10; 
                box-shadow: inset 0 1px 0 var(--vscode-editor-background), inset 0 -1px 0 var(--vscode-panel-border);
                background-clip: padding-box; border-bottom: none; user-select: none; cursor: grab;
            }
            th:active { cursor: grabbing; }
            th:hover { background-color: var(--vscode-list-hoverBackground); }

            .resizer { position: absolute; right: 0; top: 0; bottom: 0; width: 5px; cursor: col-resize; z-index: 12; }
            .resizer:hover { background-color: var(--vscode-focusBorder); }
            
            tr:nth-child(even) td { background-color: var(--vscode-list-hoverBackground); }
            
            .row-num-cell { position: sticky; left: 0px; z-index: 1; box-shadow: inset -1px 0 0 var(--vscode-focusBorder); background-clip: padding-box; }
            .frozen-cell { position: sticky; z-index: 1; box-shadow: inset -1px 0 0 var(--vscode-focusBorder); background-clip: padding-box; }
            
            th.frozen-cell, th.row-num-cell { 
                z-index: 11; 
                background-color: var(--vscode-editor-background) !important;
                box-shadow: inset -1px 0 0 var(--vscode-focusBorder), inset 0 1px 0 var(--vscode-editor-background), inset 0 -1px 0 var(--vscode-panel-border); 
            }
            
            tr:nth-child(even) td.row-num-cell { background-color: var(--vscode-list-hoverBackground); }
            tr:nth-child(odd) td.row-num-cell { background-color: var(--vscode-editor-background); }
            tr:nth-child(even) td.frozen-cell { background-color: var(--vscode-list-hoverBackground); background-image: linear-gradient(rgba(130, 200, 255, 0.12), rgba(130, 200, 255, 0.12)); }
            tr:nth-child(odd) td.frozen-cell { background-color: var(--vscode-editor-background); background-image: linear-gradient(rgba(130, 200, 255, 0.06), rgba(130, 200, 255, 0.06)); }

            #ctx-menu { display: none; position: fixed; z-index: 1000; background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border); box-shadow: 0 2px 4px rgba(0,0,0,0.5); padding: 4px 0; color: var(--vscode-menu-foreground); min-width: 120px; font-family: var(--vscode-font-family); font-size: 13px; }
            .ctx-menu-item { padding: 6px 12px; cursor: pointer; }
            .ctx-menu-item:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
        </style>
    </head>
    <body>
        <div id="stats-bar">
            <div class="top-row">
                <span id="stats-text">Loading dataset...</span>
                <div>
                    <button id="toggle-stats-btn" class="btn">📊 Column Stats</button>
                    <button id="unfreeze-btn" class="btn btn-secondary" style="display: none;">Unfreeze All</button>
                </div>
            </div>
            <div class="filter-toolbar">
                <select id="filter-mode-toggle" class="btn btn-secondary">
                    <option value="raw">Raw Query</option>
                    <option value="visual">Visual Builder</option>
                </select>
                <div id="raw-filter-container">
                    <textarea id="row-filter" rows="1" placeholder="e.g. price > 50 (Shift+Enter for new line)" title="Enter a Stata 'if' expression"></textarea>
                </div>
                <div style="flex: 1; text-align: right; font-family: monospace; font-size: 11px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" id="generated-query-preview"></div>
                <button id="apply-filter-btn" class="btn">Filter</button>
                <button id="clear-filter-btn" class="btn btn-secondary" style="display: none;">Clear</button>
            </div>
            <div id="visual-builder-container"></div>
        </div>
        <div id="grid-wrapper">
            <div id="scroll-sizer"></div>
            <table id="data-table">
                <thead><tr id="header-row"></tr></thead>
                <tbody id="data-body"></tbody>
            </table>
        </div>
        
        <div id="ctx-menu">
            <div class="ctx-menu-item" id="ctx-copy-tsv">Copy Selection (TSV)</div>
            <div class="ctx-menu-item" id="ctx-sort">Sort Column</div>
            <div class="ctx-menu-item" id="ctx-freeze">Toggle Freeze</div>
            <div class="ctx-menu-item" id="ctx-summary">Summarize Column</div>
        </div>
        
        <script>
            const vscode = acquireVsCodeApi();
            const ROW_HEIGHT = 27; 
            const ROW_NUMBER_WIDTH = 50;
            
            let totalObs = 0;
            let colDefs = []; 
            let lastData = []; 
            
            let renderedStart = 0;
            let requestedStart = 0;
            let scrollDebounce = null;
            let currentRowFilter = "";
            let validationTimeout = null;
            const rowCache = new Map();
            
            let contextMenuTargetCol = null;
            let dragSrcColIndex = null;

            let filterTree = { condition: "AND", rules: [] };
            const operatorMap = {
                "==": "==", "!=": "!=", ">": ">", ">=": ">=", "<": "<", "<=": "<=",
                "missing": "is missing", "not_missing": "is not missing",
                "contains": "contains", "not_contains": "does not contain"
            };

            let statsCache = {};
            let showStats = false;
            
            const wrapper = document.getElementById('grid-wrapper');
            const sizer = document.getElementById('scroll-sizer');
            const header = document.getElementById('header-row');
            const body = document.getElementById('data-body');
            const dataTable = document.getElementById('data-table');
            const statsText = document.getElementById('stats-text');
            const unfreezeBtn = document.getElementById('unfreeze-btn');
            const clearFilterBtn = document.getElementById('clear-filter-btn');
            const filterInput = document.getElementById('row-filter');
            const ctxMenu = document.getElementById('ctx-menu');
            
            const modeToggle = document.getElementById('filter-mode-toggle');
            const rawContainer = document.getElementById('raw-filter-container');
            const visualContainer = document.getElementById('visual-builder-container');
            const queryPreview = document.getElementById('generated-query-preview');

            document.getElementById('toggle-stats-btn').addEventListener('click', () => {
                showStats = !showStats;
                if (showStats) {
                    dataTable.classList.add('show-stats');
                    document.querySelectorAll('.col-stats').forEach(el => el.style.display = 'block');
                    const varsToFetch = colDefs.map(c => c.name).filter(n => !statsCache[n]);
                    if (varsToFetch.length > 0) vscode.postMessage({ command: 'fetch_column_stats', variables: varsToFetch });
                    else populateStats();
                } else {
                    dataTable.classList.remove('show-stats');
                    document.querySelectorAll('.col-stats').forEach(el => el.style.display = 'none');
                }
            });

            function populateStats() {
                colDefs.forEach(c => {
                    const st = statsCache[c.name];
                    const el = document.getElementById(\`stats-\${c.name}\`);
                    if (!st || !el) return;

                    let html = '';
                    if (st.type === 'string') {
                        const totalCleanPct = 100 - st.missing_pct;
                        let barHtml = '';
                        const colors = ['#007acc', '#4da6ff', '#99ccff'];
                        
                        st.top.forEach((t, i) => {
                            const width = t.pct * (totalCleanPct / 100);
                            const safeVal = t.val.replace(/"/g, '&quot;');
                            barHtml += \`<div style="width:\${width}%; background:\${colors[i]};" title="\${safeVal} (\${t.count})"></div>\`;
                        });
                        if (st.other_pct > 0) {
                            const width = st.other_pct * (totalCleanPct / 100);
                            barHtml += \`<div style="width:\${width}%; background:var(--vscode-descriptionForeground);" title="Other"></div>\`;
                        }
                        if (st.missing_pct > 0) {
                            barHtml += \`<div style="width:\${st.missing_pct}%; background:var(--vscode-charts-red);" title="Missing (\${st.missing_str})"></div>\`;
                        }

                        html += \`<div style="display:flex; height:12px; border-radius:2px; overflow:hidden; margin-bottom:6px; margin-top:2px;">\${barHtml}</div>\`;
                        html += \`<div style="display:grid; grid-template-columns: 1fr 1fr; gap: 2px; font-size:9.5px; opacity:0.85;">\`;
                        html += \`<div>Unique: <b>\${st.unique}</b></div>\`;
                        html += \`<div>Miss: <b>\${st.missing_str}</b></div>\`;
                        if (st.top.length > 0) {
                            const safeMode = st.top[0].val.replace(/"/g, '&quot;');
                            html += \`<div style="grid-column: span 2; overflow:hidden; text-overflow:ellipsis;" title="Mode: \${safeMode}">Mode: <b>\${safeMode}</b> (\${Math.round(st.top[0].pct)}%)</div>\`;
                        }
                        html += \`</div>\`;

                    } else {
                        const isDate = st.type === 'date';
                        const gap = isDate ? '0' : '1px'; 
                        
                        let bars = '';
                        st.bins.forEach(b => {
                            const bg = (isDate && b.count === 0) ? 'var(--vscode-charts-red)' : 'var(--vscode-charts-blue)';
                            const opacity = (isDate && b.count === 0) ? '0.3' : '1';
                            bars += \`<div style="height:\${Math.max(b.pct, 1)}%; flex:1; background:\${bg}; opacity:\${opacity}; margin-right:\${gap}; border-radius: 1px 1px 0 0;" title="Range: \${b.range}&#10;Count: \${b.count}"></div>\`;
                        });

                        html += \`<div style="position:relative; display:flex; align-items:flex-end; height:26px; margin-bottom:4px; border-bottom:1px solid var(--vscode-panel-border); margin-top:2px;">\`;
                        if (st.bins.length > 0 && !isDate) {
                            html += \`<div style="position:absolute; left:\${st.mean_pos}%; top:0; bottom:0; width:1px; background:var(--vscode-charts-red); z-index:2;" title="Mean: \${st.mean}"></div>\`;
                        }
                        html += bars;
                        html += \`</div>\`;

                        let badges = '';
                        if (st.has_neg) badges += \`<span style="background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); padding:0 3px; border-radius:2px; margin-right:2px; font-size:9px;" title="Contains negative values">[<0]</span>\`;
                        if (st.has_zero) badges += \`<span style="background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); padding:0 3px; border-radius:2px; margin-right:2px; font-size:9px;" title="Contains exact zeros">[0]</span>\`;

                        html += \`<div style="display:grid; grid-template-columns: 1fr 1fr; gap: 2px; font-size:9.5px; opacity:0.85;">\`;
                        if (!isDate) {
                            html += \`<div>Mean: <b>\${st.mean}</b></div>\`;
                            html += \`<div>p50: <b>\${st.median}</b></div>\`;
                        } else {
                            html += \`<div>Miss: <b>\${st.missing}</b></div>\`;
                            html += \`<div>p50: <b>\${st.median}</b></div>\`;
                        }
                        html += \`<div style="overflow:hidden; text-overflow:ellipsis;">Min: <b>\${st.min}</b> \${badges}</div>\`;
                        html += \`<div style="overflow:hidden; text-overflow:ellipsis;">Max: <b>\${st.max}</b></div>\`;
                        html += \`</div>\`;
                    }
                    
                    el.innerHTML = html;
                });
            }
            
            document.addEventListener('click', (e) => {
                if (!ctxMenu.contains(e.target)) ctxMenu.style.display = 'none';
            });
            
            modeToggle.addEventListener('change', () => {
                const mode = modeToggle.value;
                if (mode === 'visual') {
                    rawContainer.style.display = 'none';
                    visualContainer.style.display = 'block';
                    queryPreview.style.display = 'block';
                    if (filterTree.rules.length === 0 && colDefs.length > 0) filterTree.rules.push({ field: colDefs[0].name, operator: "==", value: "" });
                    renderVisualBuilder();
                } else {
                    rawContainer.style.display = 'flex';
                    visualContainer.style.display = 'none';
                    queryPreview.style.display = 'none';
                    filterInput.value = compileToStata(filterTree);
                }
            });

            document.getElementById('apply-filter-btn').addEventListener('click', applyRowFilter);
            clearFilterBtn.addEventListener('click', () => {
                filterInput.value = '';
                filterTree = { condition: "AND", rules: [] };
                renderVisualBuilder();
                applyRowFilter();
            });

            filterInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!document.getElementById('apply-filter-btn').disabled) applyRowFilter();
                }
            });

            filterInput.addEventListener('input', function() {
                this.style.height = 'auto';
                this.style.height = Math.min(this.scrollHeight, 120) + 'px';
                clearTimeout(validationTimeout);
                validationTimeout = setTimeout(() => {
                    const query = filterInput.value.replace(/\\n/g, ' ').trim();
                    if(query) vscode.postMessage({ command: 'validateFilter', query: query });
                    else { filterInput.style.borderColor = "var(--vscode-input-border)"; document.getElementById('apply-filter-btn').disabled = false; }
                }, 500);
            });

            function getNode(indices) {
                if (!indices) return filterTree;
                return indices.split(',').reduce((obj, idx) => obj.rules[idx], filterTree);
            }
            window.updateTree = function(path, key, value) { getNode(path)[key] = value; renderVisualBuilder(); };
            window.addRule = function(path) { getNode(path).rules.push({ field: colDefs.length > 0 ? colDefs[0].name : "", operator: "==", value: "" }); renderVisualBuilder(); };
            window.addGroup = function(path) { getNode(path).rules.push({ condition: "AND", rules: [{ field: colDefs.length > 0 ? colDefs[0].name : "", operator: "==", value: "" }] }); renderVisualBuilder(); };
            window.removeNode = function(path) {
                const parts = path.split(',');
                const index = parts.pop();
                getNode(parts.join(',')).rules.splice(index, 1);
                renderVisualBuilder();
            };

            function compileToStata(node) {
                if (!node.rules || node.rules.length === 0) return "";
                const parts = node.rules.map(rule => {
                    if (rule.condition) {
                        const subQuery = compileToStata(rule);
                        return subQuery ? \`(\${subQuery})\` : "";
                    } else {
                        const f = rule.field; const op = rule.operator; let v = rule.value.trim();
                        if (!f) return "";
                        if (op === "missing") return \`missing(\${f})\`;
                        if (op === "not_missing") return \`!missing(\${f})\`;
                        const isVariable = colDefs.some(c => c.name === v);
                        const col = colDefs.find(c => c.name === f);
                        if (col && !col.isNumeric && !isVariable && !v.startsWith('"') && !v.startsWith("'") && !v.startsWith('\`')) v = '"' + v + '"';
                        if (op === "contains") return \`strpos(\${f}, \${v}) > 0\`;
                        if (op === "not_contains") return \`strpos(\${f}, \${v}) == 0\`;
                        return \`\${f} \${op} \${v}\`;
                    }
                }).filter(p => p !== "");
                if (parts.length === 0) return "";
                return parts.join(node.condition === "AND" ? " & " : " | ");
            }

            function renderVisualBuilder() {
                visualContainer.innerHTML = '';
                if (colDefs.length === 0) return;
                const varOptions = colDefs.map(c => \`<option value="\${c.name}">\${c.name}</option>\`).join('');
                
                function createGroupHTML(group, path) {
                    let html = \`<div class="query-group" data-path="\${path}">
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <select class="query-select condition-select" onchange="updateTree('\${path}', 'condition', this.value)">
                                <option value="AND" \${group.condition === 'AND' ? 'selected' : ''}>Match ALL (AND)</option>
                                <option value="OR" \${group.condition === 'OR' ? 'selected' : ''}>Match ANY (OR)</option>
                            </select>
                            \${path !== '' ? \`<button class="query-btn danger" onclick="removeNode('\${path}')">✖</button>\` : ''}
                        </div>\`;
                    group.rules.forEach((rule, index) => {
                        const currentPath = path === '' ? \`\${index}\` : \`\${path},\${index}\`;
                        if (rule.condition) html += createGroupHTML(rule, currentPath);
                        else {
                            html += \`<div class="query-rule">
                                <select class="query-select" onchange="updateTree('\${currentPath}', 'field', this.value)">\${varOptions.replace(\`value="\${rule.field}"\`, \`value="\${rule.field}" selected\`)}</select>
                                <select class="query-select" onchange="updateTree('\${currentPath}', 'operator', this.value)">\${Object.entries(operatorMap).map(([k, v]) => \`<option value="\${k}" \${rule.operator === k ? 'selected' : ''}>\${v}</option>\`).join('')}</select>
                                \${(rule.operator !== 'missing' && rule.operator !== 'not_missing') ? \`<input type="text" class="query-input" value='\${rule.value.replace(/'/g, "&#39;")}' onchange="updateTree('\${currentPath}', 'value', this.value)" placeholder="Value or Variable..." />\` : ''}
                                <button class="query-btn danger" onclick="removeNode('\${currentPath}')">✖</button>
                            </div>\`;
                        }
                    });
                    html += \`<div style="display: flex; gap: 6px; margin-top: 4px;">
                            <button class="query-btn" onclick="addRule('\${path}')">+ Add Condition</button>
                            <button class="query-btn" onclick="addGroup('\${path}')">+ Add Sub-Group</button>
                        </div></div>\`;
                    return html;
                }
                
                visualContainer.innerHTML = createGroupHTML(filterTree, '');
                const generated = compileToStata(filterTree);
                queryPreview.textContent = generated ? \`Generated Query: \${generated}\` : '';
            }

            function applyRowFilter() {
                const mode = modeToggle.value;
                if (mode === 'visual') {
                    currentRowFilter = compileToStata(filterTree);
                    filterInput.value = currentRowFilter;
                } else currentRowFilter = filterInput.value.replace(/\\n/g, ' ').trim();
                
                clearFilterBtn.style.display = currentRowFilter ? 'block' : 'none';
                requestedStart = 0; renderedStart = 0; rowCache.clear(); body.innerHTML = ''; 
                vscode.postMessage({ command: '${fetchCommandName}', start: 0, end: 200, scrollToken: Date.now(), rowFilter: currentRowFilter });
            }

            function notifyFrozen() {
                const fVars = colDefs.filter(c => c.frozen).map(c => c.name);
                vscode.postMessage({ command: 'updateFrozen', frozenVars: fVars });
                unfreezeBtn.style.display = fVars.length > 0 ? 'block' : 'none';
            }

            // TSV Grid Selection Logic
            let selStart = null, selEnd = null, isDraggingSel = false;
            body.addEventListener('mousedown', e => {
                const td = e.target.closest('td:not(.row-num-cell)');
                if (td) {
                    isDraggingSel = true;
                    selStart = { r: td.parentElement.rowIndex, c: td.cellIndex };
                    selEnd = selStart;
                    drawSelection();
                }
            });
            body.addEventListener('mouseover', e => {
                if (isDraggingSel) {
                    const td = e.target.closest('td:not(.row-num-cell)');
                    if (td) { selEnd = { r: td.parentElement.rowIndex, c: td.cellIndex }; drawSelection(); }
                }
            });
            document.addEventListener('mouseup', () => isDraggingSel = false);

            function drawSelection() {
                if (!selStart || !selEnd) return;
                const r1 = Math.min(selStart.r, selEnd.r), r2 = Math.max(selStart.r, selEnd.r);
                const c1 = Math.min(selStart.c, selEnd.c), c2 = Math.max(selStart.c, selEnd.c);
                Array.from(body.rows).forEach((row, rIdx) => {
                    Array.from(row.cells).forEach((cell, cIdx) => {
                        cell.style.backgroundColor = (rIdx + 1 >= r1 && rIdx + 1 <= r2 && cIdx >= c1 && cIdx <= c2) 
                            ? 'var(--vscode-editor-selectionBackground)' : '';
                    });
                });
            }

            document.getElementById('ctx-copy-tsv').addEventListener('click', () => {
                if (!selStart || !selEnd) return;
                const r1 = Math.min(selStart.r, selEnd.r) - 1, r2 = Math.max(selStart.r, selEnd.r) - 1;
                const c1 = Math.min(selStart.c, selEnd.c), c2 = Math.max(selStart.c, selEnd.c);
                
                let tsv = [];
                for (let r = r1; r <= r2; r++) {
                    if (!lastData[r]) continue;
                    let rowData = [];
                    for (let c = c1; c <= c2; c++) {
                        const varName = colDefs[c-1]?.name;
                        rowData.push(lastData[r][varName] || "");
                    }
                    tsv.push(rowData.join('\\t'));
                }
                vscode.postMessage({ command: 'copyToClipboard', text: tsv.join('\\n') });
                ctxMenu.style.display = 'none';
            });

            document.getElementById('ctx-sort').addEventListener('click', () => {
                if(contextMenuTargetCol) vscode.postMessage({ command: 'sortVariable', varName: contextMenuTargetCol.name });
                ctxMenu.style.display = 'none';
            });
            document.getElementById('ctx-freeze').addEventListener('click', () => {
                if(contextMenuTargetCol) {
                    contextMenuTargetCol.frozen = !contextMenuTargetCol.frozen;
                    colDefs.sort((a, b) => a.frozen === b.frozen ? 0 : (a.frozen ? -1 : 1));
                    notifyFrozen(); renderChunk(lastData);
                }
                ctxMenu.style.display = 'none';
            });
            document.getElementById('ctx-summary').addEventListener('click', () => {
                if(contextMenuTargetCol) vscode.postMessage({ command: 'summarizeCol', varName: contextMenuTargetCol.name, isNumeric: contextMenuTargetCol.isNumeric, rowFilter: currentRowFilter }); 
                ctxMenu.style.display = 'none';
            });
            unfreezeBtn.addEventListener('click', () => { colDefs.forEach(c => c.frozen = false); notifyFrozen(); renderChunk(lastData); });

            window.addEventListener('message', event => {
                if (event.data.type === 'clearRowFilter') {
                    filterInput.value = ''; filterTree = { condition: "AND", rules: [] };
                    if (modeToggle.value === 'visual') renderVisualBuilder();
                    applyRowFilter();
                } else if (event.data.type === 'filter_validation') {
                    const isValid = event.data.valid;
                    filterInput.style.borderColor = isValid ? "var(--vscode-input-border)" : "var(--vscode-errorForeground)";
                    document.getElementById('apply-filter-btn').disabled = !isValid;
                } else if (event.data.type === 'column_stats_result') {
                    Object.assign(statsCache, event.data.data);
                    if (showStats) populateStats();
                } else if (event.data.type === 'chunkData') {
                    const startKey = event.data.req_start !== undefined ? event.data.req_start : requestedStart;
                    rowCache.set(startKey, event.data.data);
                    
                    if (event.data.columns) {
                        const frozenSet = event.data.frozenVars ? new Set(event.data.frozenVars) : new Set(colDefs.filter(c => c.frozen).map(c => c.name));
                        colDefs = event.data.columns.map(c => ({ name: c.name, format: c.format, isNumeric: c.isNumeric, width: colDefs.find(old => old.name === c.name)?.width || 120, frozen: frozenSet.has(c.name) }));
                        colDefs.sort((a, b) => a.frozen === b.frozen ? 0 : (a.frozen ? -1 : 1));
                        notifyFrozen();
                        if (modeToggle.value === 'visual' && visualContainer.innerHTML === '') {
                            if (filterTree.rules.length === 0 && colDefs.length > 0) filterTree.rules.push({ field: colDefs[0].name, operator: "==", value: "" });
                            renderVisualBuilder();
                        }
                    }
                    totalObs = event.data.total || 0;
                    statsText.textContent = totalObs.toLocaleString() + ' observations, ' + colDefs.length + ' variables';
                    sizer.style.height = (totalObs * ROW_HEIGHT + 35) + 'px';
                    renderedStart = startKey; lastData = event.data.data || [];
                    renderChunk(lastData);
                } else if (event.data.type === 'resetData') {
                    renderedStart = 0; requestedStart = 0; rowCache.clear(); lastData = []; body.innerHTML = ''; header.innerHTML = ''; statsText.textContent = 'Loading dataset...'; statsCache = {};
                }
            });

            function renderChunk(rows) {
                if (!colDefs || colDefs.length === 0) { header.innerHTML = '<th>No dataset loaded</th>'; body.innerHTML = ''; return; }
                let headerHtml = \`<th class="row-num-cell" style="width: \${ROW_NUMBER_WIDTH}px; min-width: \${ROW_NUMBER_WIDTH}px; max-width: \${ROW_NUMBER_WIDTH}px;">#</th>\`;
                let currentLeft = ROW_NUMBER_WIDTH;
                colDefs.forEach((c, idx) => {
                    let stickyStyle = c.frozen ? \`position: sticky; left: \${currentLeft}px;\` : '';
                    if (c.frozen) currentLeft += c.width;
                    headerHtml += \`<th draggable="true" data-idx="\${idx}" class="\${c.frozen ? 'frozen-cell' : ''}" style="width: \${c.width}px; min-width: \${c.width}px; max-width: \${c.width}px; \${stickyStyle}">
                        \${c.name}
                        <div class="col-stats" id="stats-\${c.name}" style="display:\${showStats ? 'block' : 'none'}; font-size:10px; font-weight:normal; margin-top:4px;">Loading...</div>
                        <div class="resizer" data-idx="\${idx}"></div>
                    </th>\`;
                });
                header.innerHTML = headerHtml;
                if (showStats) populateStats();
                
                Array.from(header.querySelectorAll('th[draggable="true"]')).forEach(th => {
                    th.addEventListener('dragstart', e => { dragSrcColIndex = parseInt(th.getAttribute('data-idx')); e.dataTransfer.effectAllowed = 'move'; });
                    th.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
                    th.addEventListener('drop', e => {
                        e.stopPropagation();
                        const tgtIndex = parseInt(th.getAttribute('data-idx'));
                        if (dragSrcColIndex !== null && dragSrcColIndex !== tgtIndex) {
                            const srcCol = colDefs[dragSrcColIndex], tgtCol = colDefs[tgtIndex];
                            if (srcCol.frozen !== tgtCol.frozen) return; 
                            vscode.postMessage({ command: 'reorderVariable', src: srcCol.name, tgt: tgtCol.name, insertBefore: dragSrcColIndex > tgtIndex });
                        }
                        return false;
                    });
                    th.addEventListener('contextmenu', e => {
                        e.preventDefault();
                        contextMenuTargetCol = colDefs[parseInt(th.getAttribute('data-idx'))];
                        document.getElementById('ctx-freeze').textContent = contextMenuTargetCol.frozen ? 'Unfreeze Column' : 'Freeze Column';
                        ctxMenu.style.display = 'block'; ctxMenu.style.left = e.clientX + 'px'; ctxMenu.style.top = e.clientY + 'px';
                    });
                });

                Array.from(header.querySelectorAll('.resizer')).forEach(resizer => {
                    let startX, startW, colIdx;
                    resizer.addEventListener('mousedown', function(e) {
                        e.preventDefault(); e.stopPropagation(); 
                        colIdx = parseInt(resizer.getAttribute('data-idx'));
                        startX = e.clientX; startW = colDefs[colIdx].width;
                        const th = resizer.closest('th'); if (th) th.setAttribute('draggable', 'false');
                        document.addEventListener('mousemove', mouseMoveHandler); document.addEventListener('mouseup', mouseUpHandler);
                    });
                    const mouseMoveHandler = function(e) {
                        const newW = Math.max(30, startW + (e.clientX - startX));
                        colDefs[colIdx].width = newW;
                        const targetColIndex = colIdx + 1; 
                        const th = header.children[targetColIndex];
                        if(th) { th.style.width = newW + 'px'; th.style.minWidth = newW + 'px'; th.style.maxWidth = newW + 'px'; }
                        Array.from(body.children).forEach(tr => {
                            const td = tr.children[targetColIndex];
                            if(td) { td.style.width = newW + 'px'; td.style.minWidth = newW + 'px'; td.style.maxWidth = newW + 'px'; }
                        });
                    };
                    const mouseUpHandler = function() { document.removeEventListener('mousemove', mouseMoveHandler); document.removeEventListener('mouseup', mouseUpHandler); renderChunk(lastData); };
                });

                let bodyHtml = '';
                const topPadding = renderedStart * ROW_HEIGHT;
                if (topPadding > 0) bodyHtml += \`<tr style="height: \${topPadding}px; background: transparent;"><td colspan="\${colDefs.length + 1}" style="border: none; padding: 0;"></td></tr>\`;

                rows.forEach((r, idx) => {
                    let rowHtml = \`<tr style="height: \${ROW_HEIGHT}px"><td class="row-num-cell" style="width: \${ROW_NUMBER_WIDTH}px; min-width: \${ROW_NUMBER_WIDTH}px; max-width: \${ROW_NUMBER_WIDTH}px;">\${renderedStart + idx + 1}</td>\`;
                    currentLeft = ROW_NUMBER_WIDTH;
                    colDefs.forEach(c => {
                        let stickyStyle = c.frozen ? \`position: sticky; left: \${currentLeft}px;\` : '';
                        if (c.frozen) currentLeft += c.width;
                        const val = r[c.name] !== undefined && r[c.name] !== null ? r[c.name] : '';
                        const cssClass = \`\${c.frozen ? 'frozen-cell' : ''} \${c.isNumeric ? 'num-cell' : ''}\`;
                        rowHtml += \`<td class="\${cssClass}" style="width: \${c.width}px; min-width: \${c.width}px; max-width: \${c.width}px; \${stickyStyle}" title="\${val}">\${val}</td>\`;
                    });
                    bodyHtml += rowHtml + '</tr>';
                });
                body.innerHTML = bodyHtml;
            }
            
            wrapper.addEventListener('scroll', () => {
                const startRow = Math.max(0, Math.floor(wrapper.scrollTop / ROW_HEIGHT) - 30);
                clearTimeout(scrollDebounce);
                scrollDebounce = setTimeout(() => {
                    if (Math.abs(startRow - requestedStart) > 40 && startRow < totalObs) {
                        requestedStart = startRow;
                        if (rowCache.has(startRow)) {
                            renderedStart = startRow; lastData = rowCache.get(startRow); renderChunk(lastData);
                        } else vscode.postMessage({ command: '${fetchCommandName}', start: startRow, end: startRow + 200, scrollToken: Date.now(), rowFilter: currentRowFilter });
                    }
                }, 100);
            });
            vscode.postMessage({ command: '${fetchCommandName}', start: 0, end: 200, scrollToken: Date.now(), rowFilter: currentRowFilter });
        </script>
    </body>
    </html>`;
}

// ============================================================================
// DATASET PROFILER DASHBOARD
// ============================================================================
let profilerWebviewPanel = null;

async function showProfilerWebview(context) {
    if (profilerWebviewPanel) {
        profilerWebviewPanel.reveal(vscode.ViewColumn.Active);
        return;
    }

    profilerWebviewPanel = vscode.window.createWebviewPanel('stataProfiler', 'Stata Dataset Profiler', vscode.ViewColumn.Active, { enableScripts: true });
    profilerWebviewPanel.onDidDispose(() => { profilerWebviewPanel = null; });

    profilerWebviewPanel.webview.html = `
        <html lang="en"><head><style>body { background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); padding: 40px; text-align: center; } .spinner { margin-top: 50px; font-size: 1.5em; opacity: 0.7; }</style></head><body><h2>Profiling Dataset...</h2><div class="spinner">Scanning memory blocks...</div></body></html>`;

    const response = await sendToBackend({ cmd: 'profile_dataset' });

    if (response && response.data && !response.data.error) {
        const d = response.data;
        const rows = d.vars.map(v => {
            const barColor = v.missing_pct > 50 ? '#d13438' : (v.missing_pct > 0 ? '#d7a22a' : '#238636');
            return `<tr><td style="font-family: monospace; font-weight: bold;">${v.name}</td><td>${v.type}</td><td><div style="display: flex; align-items: center; gap: 8px;"><div style="flex: 1; background: var(--vscode-editorWidget-background); height: 8px; border-radius: 4px; overflow: hidden;"><div style="width: ${v.missing_pct}%; background: ${barColor}; height: 100%;"></div></div><span style="width: 45px; text-align: right; font-size: 0.9em;">${v.missing_pct}%</span></div></td><td>${v.missing}</td><td>${v.mean !== null ? v.mean : '—'}</td><td>${v.min !== null ? v.min : '—'}</td><td>${v.max !== null ? v.max : '—'}</td></tr>`;
        }).join('');

        profilerWebviewPanel.webview.html = `
            <!DOCTYPE html><html lang="en"><head><style>body { background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); padding: 20px; } .header { margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid var(--vscode-panel-border); } h2 { margin: 0 0 5px 0; } .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; } table { width: 100%; border-collapse: collapse; text-align: left; } th, td { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); } th { background-color: var(--vscode-editorWidget-background); position: sticky; top: 0; z-index: 10; } tr:hover { background-color: var(--vscode-list-hoverBackground); }</style></head><body><div class="header"><h2>📊 Dataset Profiler</h2><div class="meta">Total Observations: <strong>${d.total_obs.toLocaleString()}</strong> | Variables: <strong>${d.vars.length}</strong></div></div><table><thead><tr><th>Variable</th><th>Type</th><th>Missing (%)</th><th>Missing (N)</th><th>Mean</th><th>Min</th><th>Max</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    } else {
        profilerWebviewPanel.webview.html = `<body><h3>Error profiling dataset</h3><p>${response?.data?.error || 'Unknown error'}</p></body>`;
    }
}

// ============================================================================
// EXTENSION ACTIVATION
// ============================================================================
function activate(context) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(check) Stata: Ready';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    stataDiagnosticCollection = vscode.languages.createDiagnosticCollection('stata');
    context.subscriptions.push(stataDiagnosticCollection);

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.languageId === 'stata') {
            clearTimeout(lintTimeout);
            lintTimeout = setTimeout(() => lintStataDocument(e.document, variablesProvider), 500);
        }
    }));

    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => {
        if (doc.languageId === 'stata') lintStataDocument(doc, variablesProvider);
    }));

    context.subscriptions.push(vscode.window.registerWebviewViewProvider('stataResultsView', resultsProvider));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('stata-ide-variables-view', variablesProvider, { webviewOptions: { retainContextWhenHidden: true } }));
    context.subscriptions.push(vscode.window.registerCustomEditorProvider('stata-ide.dtaViewer', new StataOfflineViewerProvider(context), { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));

    vscode.window.createTreeView('stata-ide-stored-results-view', { treeDataProvider: storedResultsProvider });
    vscode.window.createTreeView('stata-ide-history-view', { treeDataProvider: historyProvider });

    const stataSelector = [
        { scheme: 'file', language: 'stata' },
        { pattern: '**/*.do' },
        { pattern: '**/*.ado' }
    ];

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(stataSelector, new StataCompletionProvider(variablesProvider, storedResultsProvider), '`', '$'),
        vscode.languages.registerHoverProvider(stataSelector, new StataHoverProvider(variablesProvider, storedResultsProvider)),
        vscode.languages.registerDocumentSymbolProvider(stataSelector, new StataDocumentSymbolProvider()),
        vscode.languages.registerCodeLensProvider(stataSelector, new StataCodeLensProvider()),
        vscode.languages.registerFoldingRangeProvider(stataSelector, new StataFoldingRangeProvider()),
        vscode.languages.registerRenameProvider(stataSelector, new StataRenameProvider()),
        vscode.languages.registerDocumentSemanticTokensProvider(stataSelector, new StataSemanticTokenProvider(), semanticLegend),
        vscode.languages.registerDocumentFormattingEditProvider(stataSelector, new StataDocumentFormattingEditProvider()),
        vscode.languages.registerDefinitionProvider(stataSelector, new StataDefinitionProvider())
    );

    initializeBackend(context);

    const runCellCmd = vscode.commands.registerCommand('stata-ide.runCell', (range, document, cellName = "Code Cell") => {
        if (!document) return;
        vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
        const code = document.getText(range);
        resultsProvider.appendCommand(`\n. [Running: ${cellName}]\n`);
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        historyProvider.addCommand({ name: cellName, code: code, time: timeStr, isError: false });
        sendToBackend({ cmd: "execute", code: code });
    });

    const executeCodeCmd = vscode.commands.registerCommand('stata-ide.executeCode', (argCode) => {
        const editor = vscode.window.activeTextEditor;
        let code = '';
        let historyName = '';

        if (argCode && typeof argCode === 'string') {
            code = argCode;
            historyName = "Execute";
        } else if (editor) {
            const selection = editor.selection;
            if (selection.isEmpty) {
                const currentLine = editor.document.lineAt(selection.start.line);
                const text = currentLine.text;

                if (text.includes('{')) {
                    let braceCount = 0;
                    let endLine = -1;
                    for (let i = selection.start.line; i < editor.document.lineCount; i++) {
                        const lineText = editor.document.lineAt(i).text;
                        if (!/^\s*\/\//.test(lineText) && !/^\s*\*/.test(lineText)) {
                            for (let char of lineText) {
                                if (char === '{') braceCount++;
                                else if (char === '}') braceCount--;
                            }
                        }
                        if (braceCount === 0) { endLine = i; break; }
                    }
                    if (endLine !== -1) {
                        const startPos = new vscode.Position(selection.start.line, 0);
                        const endPos = editor.document.lineAt(endLine).range.end;
                        code = editor.document.getText(new vscode.Range(startPos, endPos));
                        historyName = `Block (Lines ${selection.start.line + 1}-${endLine + 1})`;
                        const nextLine = endLine + 1;
                        if (nextLine < editor.document.lineCount) {
                            const nextPos = new vscode.Position(nextLine, 0);
                            editor.selection = new vscode.Selection(nextPos, nextPos);
                            editor.revealRange(new vscode.Range(nextPos, nextPos));
                        }
                    }
                }

                if (!code) {
                    code = text;
                    historyName = `Line ${selection.start.line + 1}`;
                    const nextLine = selection.start.line + 1;
                    if (nextLine < editor.document.lineCount) {
                        const nextPos = new vscode.Position(nextLine, 0);
                        editor.selection = new vscode.Selection(nextPos, nextPos);
                        editor.revealRange(new vscode.Range(nextPos, nextPos));
                    }
                }
            } else {
                code = editor.document.getText(selection);
                historyName = `Code chunk (Line ${selection.start.line + 1} to${selection.end.line + 1})`;
            }
        }
        if (!code.trim()) return;

        vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
        resultsProvider.appendCommand(`\n. ${code.split('\n')[0]}\n`);
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        historyProvider.addCommand({ name: historyName, code: code, time: timeStr, isError: false });
        sendToBackend({ cmd: "execute", code: code });
    });

    const executeFileCmd = vscode.commands.registerCommand('stata-ide.executeFile', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const fullText = editor.document.getText();
        const originalFileName = path.basename(editor.document.fileName) || 'Untitled.do';
        const displayPath = editor.document.fileName.replace(/\\/g, '/');
        const tempFileName = `stata_tmp_${Date.now()}.do`;
        const tempFilePath = path.join(os.tmpdir(), tempFileName);

        try { fs.writeFileSync(tempFilePath, fullText); }
        catch (err) { vscode.window.showErrorMessage(`Failed to write temp file: ${err.message}`); return; }

        const cleanTempPath = tempFilePath.replace(/\\/g, '/');
        const executeCommand = `do "${cleanTempPath}"`;

        vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
        resultsProvider.appendCommand(`\n. do "${displayPath}"\n`);
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        historyProvider.addCommand({ name: originalFileName, code: executeCommand, time: timeStr, isError: false });
        sendToBackend({ cmd: "execute", code: executeCommand, tempFile: cleanTempPath });
    });

    const runBackgroundCmd = vscode.commands.registerCommand('stata-ide.runBackground', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const selection = editor.selection;
        let code = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);
        const tempFilePath = path.join(os.tmpdir(), `stata_bg_${Date.now()}.do`);
        try { fs.writeFileSync(tempFilePath, code); }
        catch (err) { vscode.window.showErrorMessage(`Failed to write temp file: ${err.message}`); return; }

        const bgOutputChannel = vscode.window.createOutputChannel('Stata Background Jobs');
        bgOutputChannel.show(true);
        bgOutputChannel.appendLine(`Starting background job for ${path.basename(editor.document.fileName)}...`);

        const config = vscode.workspace.getConfiguration('stata-ide');
        const bgProcess = spawn(config.get('pythonPath') || 'python', [path.join(context.extensionPath, 'backend', 'headless_runner.py'), config.get('stataPath') || '', tempFilePath]);
        bgProcess.on('error', (err) => { bgOutputChannel.appendLine(`\nError: ${err.message}`); });
        bgProcess.stdout.on('data', (data) => bgOutputChannel.append(data.toString()));
        bgProcess.stderr.on('data', (data) => bgOutputChannel.append(data.toString()));
        bgProcess.on('close', (code) => {
            bgOutputChannel.appendLine(`\nBackground job exited with code ${code}`);
            const fileName = path.basename(editor.document.fileName);
            if (code === 0) vscode.window.showInformationMessage(`Background Stata Job Success: ${fileName}`, 'View Output').then(choice => { if (choice === 'View Output') bgOutputChannel.show(); });
            else vscode.window.showErrorMessage(`Background Stata Job Failed: ${fileName}`, 'View Output').then(choice => { if (choice === 'View Output') bgOutputChannel.show(); });
        });
    });

    const stopExecutionCmd = vscode.commands.registerCommand('stata-ide.stopExecution', () => {
        if (stataProcess) {
            vscode.window.showWarningMessage(
                "Stata blocks process interrupts natively. To stop execution, the engine must be restarted (memory will be cleared). Continue?",
                "Restart Engine", "Cancel"
            ).then(choice => {
                if (choice === "Restart Engine") {
                    resultsProvider.appendError("\n[System]: Restarting Stata engine to halt execution...\n");
                    stataProcess.kill();
                    if (activeDatasetWebview) activeDatasetWebview.postMessage({ type: 'resetData' });
                    variablesProvider.refresh([]);
                    setTimeout(() => initializeBackend(context), 1000);
                }
            });
        }
    });

    const viewDatasetCmd = vscode.commands.registerCommand('stata-ide.viewActiveDataset', () => {
        if (activeDatasetPanel) { activeDatasetPanel.reveal(vscode.ViewColumn.Beside, true); return; }
        activeDatasetPanel = vscode.window.createWebviewPanel('activeDatasetViewer', 'Stata: Active Dataset', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
        const gridIconUri = vscode.Uri.file(path.join(context.extensionPath, 'resources', 'dta-file.png'));
        activeDatasetPanel.iconPath = { light: gridIconUri, dark: gridIconUri };
        activeDatasetWebview = activeDatasetPanel.webview;
        activeDatasetPanel.webview.html = getGridHtml('fetchActiveChunk');
        activeDatasetPanel.onDidDispose(() => { activeDatasetWebview = null; activeDatasetPanel = null; });

        activeDatasetPanel.webview.onDidReceiveMessage(e => {
            if (e.command === 'fetchActiveChunk') {
                activeRowFilter = e.rowFilter || "";
                sendToBackend({ cmd: 'fetch_active', start: e.start, end: e.end, variables: activeVariablesSubset, scrollToken: e.scrollToken, rowFilter: activeRowFilter });
            } else if (e.command === 'reorderVariable') {
                const code = `order ${e.src}, ${e.insertBefore ? 'before' : 'after'}(${e.tgt})`;
                vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
                resultsProvider.appendCommand(`\n. ${code}\n`);
                sendToBackend({ cmd: "execute", code: code });
            } else if (e.command === 'sortVariable') {
                const code = `gsort ${e.varName}`;
                vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
                resultsProvider.appendCommand(`\n. ${code}\n`);
                sendToBackend({ cmd: "execute", code: code });
            } else if (e.command === 'updateFrozen') {
                variablesProvider.setFrozen(e.frozenVars);
            } else if (e.command === 'summarizeCol') {
                const ifCondition = e.rowFilter ? ` if ${e.rowFilter}` : "";
                const code = e.isNumeric ? `summarize ${e.varName}${ifCondition}, detail` : `tabulate ${e.varName}${ifCondition}`;
                vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
                resultsProvider.appendCommand(`\n. ${code}\n`);
                sendToBackend({ cmd: "execute", code: code });
            } else if (e.command === 'validateFilter') {
                sendToBackend({ cmd: 'validate_filter', query: e.query });
            } else if (e.command === 'fetch_column_stats') {
                sendToBackend({ cmd: 'fetch_column_stats', variables: e.variables });
            } else if (e.command === 'copyToClipboard') {
                vscode.env.clipboard.writeText(e.text);
            }
        });
    });

    const filterVariablesCmd = vscode.commands.registerCommand('stata-ide.variables.filter', () => {
        vscode.commands.executeCommand('stata-ide-variables-view.focus').then(() => variablesProvider.focusFilter());
    });
    const selectAllCmd = vscode.commands.registerCommand('stata-ide.variables.selectAll', () => { variablesProvider.selectAll(); });
    const unselectAllCmd = vscode.commands.registerCommand('stata-ide.variables.unselectAll', () => { variablesProvider.unselectAll(); });
    const clearResultsCmd = vscode.commands.registerCommand('stata-ide.clearResults', () => { resultsProvider.clear(); });
    const clearRowFilterCmd = vscode.commands.registerCommand('stata-ide.clearRowFilter', () => {
        if (activeDatasetPanel && activeDatasetWebview) activeDatasetWebview.postMessage({ type: 'clearRowFilter' });
    });

    const browseSelectedCmd = vscode.commands.registerCommand('stata-ide.browseSelected', () => {
        let candidateVars = variablesProvider.variables;
        if (variablesProvider.filterText) {
            const fText = variablesProvider.filterText;
            candidateVars = candidateVars.filter(v => v.name.toLowerCase().includes(fText) || (v.label && v.label.toLowerCase().includes(fText)));
        }
        let selected = candidateVars.filter(v => variablesProvider.selectedVars.has(v.name)).map(v => v.name);
        if (selected.length === 0) {
            vscode.window.showInformationMessage("No specific variables checked in current view. Showing all visible.");
            selected = candidateVars.map(v => v.name);
        }
        activeVariablesSubset = (!variablesProvider.filterText && selected.length === variablesProvider.variables.length) ? [] : selected;

        if (activeDatasetPanel) {
            activeDatasetWebview.postMessage({ type: 'resetData' });
            sendToBackend({ cmd: 'fetch_active', start: 0, end: 200, variables: activeVariablesSubset, rowFilter: activeRowFilter });
        } else vscode.commands.executeCommand('stata-ide.viewActiveDataset');
    });

    const insertResultCmd = vscode.commands.registerCommand('stata-ide.results.insert', (arg) => {
        let text = (typeof arg === 'string') ? arg : (arg && arg.key ? (arg.prefix === 'g' ? `$${arg.key}` : `\`${arg.prefix}(${arg.key})'`) : "");
        if (isDoubleClick(`res_${text}`)) {
            vscode.commands.executeCommand('stataResultsView.focus').then(() => {
                setTimeout(() => { if (resultsProvider._view && text) resultsProvider._view.webview.postMessage({ type: 'insert_cli', text: text }); }, 50);
            });
        }
    });

    const populateHistoryCmd = vscode.commands.registerCommand('stata-ide.history.populate', (arg) => {
        const cmdText = (typeof arg === 'string') ? arg : (arg.code || '');
        if (isDoubleClick(`hist_${cmdText}`)) {
            vscode.commands.executeCommand('stataResultsView.focus').then(() => {
                setTimeout(() => { if (resultsProvider._view && cmdText) resultsProvider._view.webview.postMessage({ type: 'insert_cli', text: cmdText }); }, 50);
            });
        }
    });

    const helpCmd = vscode.commands.registerCommand('stata-ide.help', (cmdName) => {
        vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
        resultsProvider.appendCommand(`\n. help ${cmdName}\n`);
        sendToBackend({ cmd: "execute", code: `help ${cmdName}` });
    });

    const generateCodebookCmd = vscode.commands.registerCommand('stata-ide.generateCodebook', () => {
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        historyProvider.addCommand({ name: "codebook", code: "codebook", time: timeStr, isError: false });
        sendToBackend({ cmd: "execute", code: "codebook" });
    });

    context.subscriptions.push(
        executeCodeCmd, executeFileCmd, runBackgroundCmd, stopExecutionCmd, viewDatasetCmd, filterVariablesCmd,
        selectAllCmd, unselectAllCmd, clearResultsCmd, clearRowFilterCmd, browseSelectedCmd,
        insertResultCmd, populateHistoryCmd, helpCmd, generateCodebookCmd, runCellCmd, vscode.commands.registerCommand('stata-ide.profileDataset', () => showProfilerWebview(context))
    );
}

function deactivate() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (stataProcess) {
        try { stataProcess.stdin.write(JSON.stringify({ cmd: 'exit' }) + '\n'); } catch (e) { }
        setTimeout(() => { if (stataProcess && !stataProcess.killed) stataProcess.kill(); }, 500);
    }
}

module.exports = { activate, deactivate };