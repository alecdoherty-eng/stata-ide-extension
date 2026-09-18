const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let stataProcess = null;
let activeDatasetPanel = null;
let graphWebviewPanel = null;
let activeDatasetWebview = null;
let pendingRequests = new Map();
let requestIdCounter = 0;
let heartbeatInterval = null;
let activeVariablesSubset = [];
let variablesTreeView = null;

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
// STATA RESULTS WEBVIEW PROVIDER 
// ============================================================================
class StataResultsViewProvider {
    constructor() {
        this._view = null;
    }
    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'execute') {
                const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                historyProvider.addCommand({ name: msg.code, code: msg.code, time: timeStr, isError: false });

                this.appendCommand(`\n. ${msg.code}\n`);
                sendToBackend({ cmd: 'execute', code: msg.code });
            }
        });
    }

    appendCommand(text) {
        if (this._view) this._view.webview.postMessage({ type: 'command', text: text });
    }

    appendOutput(text) {
        if (this._view) this._view.webview.postMessage({ type: 'output', text: text });
    }

    appendError(text) {
        if (this._view) this._view.webview.postMessage({ type: 'error_text', text: text });
    }

    clear() {
        if (this._view) this._view.webview.postMessage({ type: 'clear' });
    }

    getHtml() {
        return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <style>
                body { display: flex; flex-direction: column; height: 100vh; margin: 0; padding: 0; font-family: monospace; background-color: #1e1e1e; font-size: 13px; line-height: 1.4; }
                #output { flex: 1; overflow-y: auto; padding: 8px; white-space: pre-wrap; }
                #cli { display: flex; padding: 8px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-input-background); }
                #cli-prompt { color: #569cd6; margin-right: 8px; font-weight: bold; }
                #cli-input { flex: 1; background: transparent; border: none; color: #d4d4d4; font-family: monospace; font-size: 13px; outline: none; }
            </style>
        </head>
        <body>
            <div id="output"></div>
            <div id="cli">
                <span id="cli-prompt">.</span>
                <input type="text" id="cli-input" placeholder="Type a Stata command and press Enter..." />
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                const out = document.getElementById('output');
                const input = document.getElementById('cli-input');
                let isCommandBlock = false;
                
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        const val = input.value.trim();
                        if (val) {
                            vscode.postMessage({ type: 'execute', code: val });
                            input.value = '';
                        }
                    }
                });

                window.addEventListener('message', event => {
                    if (event.data.type === 'insert_cli') {
                        const needsSpace = input.value.length > 0 && !input.value.endsWith(' ');
                        input.value += (needsSpace ? ' ' : '') + event.data.text;
                        input.focus();
                        return;
                    }

                    if (event.data.type === 'clear') {
                        out.innerHTML = '';
                        isCommandBlock = false;
                        return;
                    }
                    
                    if (event.data.type === 'error_text') {
                        const span = document.createElement('span');
                        span.style.color = '#f14c4c'; 
                        span.textContent = event.data.text;
                        out.appendChild(span);
                        out.scrollTop = out.scrollHeight;
                        isCommandBlock = false;
                        return;
                    }

                    const lines = event.data.text.split('\\n');
                    lines.forEach((line, index) => {
                        if (!line && index === lines.length - 1) return;
                        
                        if (event.data.type === 'command' || line.startsWith('. ') || line.startsWith('> ')) {
                            isCommandBlock = true;
                        } else if (line.trim().length > 0) {
                            isCommandBlock = false;
                        }
                        
                        const span = document.createElement('span');
                        span.style.color = isCommandBlock ? '#569cd6' : '#d4d4d4'; 
                        span.textContent = line + (index < lines.length - 1 ? '\\n' : '');
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
// DATA PROVIDERS & TREE VIEWS
// ============================================================================
class VariablesProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.variables = [];
        this.filterText = "";
        this.frozenVars = new Set();
    }
    refresh(newVariables) {
        if (newVariables) {
            const oldStates = new Map(this.variables.map(v => [v.name, v.checkboxState]));
            this.variables = newVariables.map(v => ({
                ...v,
                checkboxState: oldStates.has(v.name) ? oldStates.get(v.name) : vscode.TreeItemCheckboxState.Checked
            }));
        }
        this._onDidChangeTreeData.fire();
    }
    setFilter(text) {
        this.filterText = text ? text.toLowerCase() : "";
        vscode.commands.executeCommand('setContext', 'stata-ide.variablesFiltered', this.filterText.length > 0);
        this.refresh();
    }
    setFrozen(frozenArray) {
        this.frozenVars = new Set(frozenArray);
        this._onDidChangeTreeData.fire();
    }
    selectAll() { this.variables.forEach(v => v.checkboxState = vscode.TreeItemCheckboxState.Checked); this.refresh(); }
    unselectAll() { this.variables.forEach(v => v.checkboxState = vscode.TreeItemCheckboxState.Unchecked); this.refresh(); }

    getTreeItem(element) {
        const item = new vscode.TreeItem(element.name);
        const labelText = element.label ? element.label : '';
        const isFrozen = this.frozenVars.has(element.name);

        item.description = `[${element.type}]${labelText}`;
        item.tooltip = `${element.name} (${element.type})\n${labelText}${isFrozen ? '\n\n(Frozen in Viewer)' : ''}`;

        let iconName = 'symbol-variable';
        if (element.type.toLowerCase().startsWith('str')) { iconName = 'symbol-string'; }
        else if (element.format && (element.format.startsWith('%t') || element.format.startsWith('%d'))) { iconName = 'calendar'; }
        else { iconName = 'symbol-number'; }

        item.iconPath = new vscode.ThemeIcon(iconName);
        item.checkboxState = element.checkboxState !== undefined ? element.checkboxState : vscode.TreeItemCheckboxState.Checked;

        item.resourceUri = vscode.Uri.parse(`stata-var:///${element.name}`);

        item.command = { command: 'stata-ide.variables.insert', title: 'Insert Variable', arguments: [element] };
        return item;
    }
    getChildren() {
        if (this.filterText) {
            const filtered = this.variables.filter(v => v.name.toLowerCase().includes(this.filterText) || (v.label && v.label.toLowerCase().includes(this.filterText)));
            return Promise.resolve(filtered);
        }
        return Promise.resolve(this.variables);
    }
}

class VariableDecorationProvider {
    constructor(variablesProvider) {
        this.variablesProvider = variablesProvider;
        this._onDidChangeFileDecorations = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

        this.variablesProvider.onDidChangeTreeData(() => {
            this._onDidChangeFileDecorations.fire();
        });
    }

    provideFileDecoration(uri) {
        if (uri.scheme === 'stata-var') {
            const varName = uri.path.substring(1);
            if (this.variablesProvider.frozenVars.has(varName)) {
                return new vscode.FileDecoration(
                    '❄',
                    'Frozen in Viewer',
                    new vscode.ThemeColor('terminal.ansiCyan')
                );
            }
        }
        return null;
    }
}

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
        if (entry && entry.code && entry.code.trim()) {
            this.history.push(entry);
            this._onDidChangeTreeData.fire();
        }
    }
    markLastError() {
        if (this.history.length > 0) {
            this.history[this.history.length - 1].isError = true;
            this._onDidChangeTreeData.fire();
        }
    }
    getTreeItem(element) {
        const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
        item.description = element.time;
        item.tooltip = element.code;

        item.iconPath = element.isError
            ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
            : new vscode.ThemeIcon('history');

        item.command = { command: 'stata-ide.history.populate', title: 'Populate', arguments: [element] };
        return item;
    }
    getChildren() {
        return Promise.resolve(this.history);
    }
}

const resultsProvider = new StataResultsViewProvider();
const variablesProvider = new VariablesProvider();
const storedResultsProvider = new StoredResultsProvider();
const historyProvider = new HistoryProvider();

// ============================================================================
// OFFLINE BINARY .DTA VIEWER PROVIDER
// ============================================================================
class StataOfflineViewerProvider {
    constructor(context) {
        this.context = context;
    }

    async openCustomDocument(uri, openContext, token) {
        return { uri, dispose: () => { } };
    }

    async resolveCustomEditor(document, webviewPanel, token) {
        webviewPanel.webview.options = { enableScripts: true };
        webviewPanel.webview.html = getGridHtml('fetch_chunk');

        const config = vscode.workspace.getConfiguration('stata-ide');
        const pythonPath = config.get('pythonPath') || 'python';
        const scriptPath = path.join(this.context.extensionPath, 'backend', 'offline_dta.py');

        const offlineProcess = spawn(pythonPath, [scriptPath, document.uri.fsPath]);
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
                        webviewPanel.webview.postMessage({
                            type: 'chunkData',
                            data: [],
                            total: parsed.total,
                            columns: parsed.columns
                        });
                    } else if (parsed.type === 'dataChunk') {
                        parsed.type = 'chunkData';
                        webviewPanel.webview.postMessage(parsed);
                    } else if (parsed.type === 'error') {
                        vscode.window.showErrorMessage(`Offline Viewer Error: ${parsed.data}`);
                    }
                } catch (e) {
                    console.error("Failed to parse offline IPC:", e);
                }
            }
        });

        webviewPanel.webview.onDidReceiveMessage(e => {
            if (e.command === 'fetch_chunk' && offlineProcess.stdin) {
                offlineProcess.stdin.write(JSON.stringify({ cmd: 'fetch_chunk', start: e.start, end: e.end }) + '\n');
            }
        });

        webviewPanel.onDidDispose(() => {
            if (offlineProcess) {
                offlineProcess.kill();
            }
        });
    }
}

// ============================================================================
// LANGUAGE INTELLIGENCE 
// ============================================================================
const stataHelpDocs = [
    // Data Types
    { cmd: "byte", min: 4, help: "Byte data type (integers between -127 and 100)." },
    { cmd: "int", min: 3, help: "Integer data type (-32,767 to 32,740)." },
    { cmd: "long", min: 4, help: "Long integer data type." },
    { cmd: "float", min: 5, help: "Float data type (4-byte real, ~7 digits accuracy)." },
    { cmd: "double", min: 6, help: "Double data type (8-byte real, ~16 digits accuracy)." },
    { cmd: "str", min: 3, help: "String data type (e.g., str1, str20, strL)." },

    // Prefix Commands
    { cmd: "by", min: 2, help: "Repeat command on subsets of the data.\n\n**Syntax:** `by varlist: command`" },
    { cmd: "bysort", min: 3, help: "Sort data and repeat command on subsets.\n\n**Syntax:** `bysort varlist: command`" },
    { cmd: "mi", min: 2, help: "Multiple imputation commands." },
    { cmd: "svy", min: 3, help: "Survey data estimation prefix." },

    // Data Management
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

    // Statistics & Estimation
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

    // Programming & Macros
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

    // Graphics
    { cmd: "graph", min: 2, help: "The graph command.\n\n**Syntax:** `graph subcommand ...`" },
    { cmd: "histogram", min: 4, help: "Histograms for continuous and categorical variables.\n\n**Syntax:** `histogram varname [if] [in] [weight] [, options]`" },
    { cmd: "kdensity", min: 2, help: "Univariate kernel density estimation.\n\n**Syntax:** `kdensity varname [if] [in] [weight] [, options]`" },
    { cmd: "line", min: 2, help: "Twoway line plots.\n\n**Syntax:** `line yvar xvar [if] [in] [, options]`" },
    { cmd: "scatter", min: 2, help: "Twoway scatterplots.\n\n**Syntax:** `scatter yvar xvar [if] [in] [, options]`" },
    { cmd: "twoway", min: 2, help: "Two-way scatterplots, line plots, etc.\n\n**Syntax:** `twoway plot [if] [in] [, twoway_options]`" },

    // Utilities
    { cmd: "cd", min: 2, help: "Change directory.\n\n**Syntax:** `cd [\"\"dir\"\"]`" },
    { cmd: "dir", min: 3, help: "Display filenames.\n\n**Syntax:** `dir [\"\"pattern\"\"]`" },
    { cmd: "do", min: 2, help: "Execute commands from a file.\n\n**Syntax:** `do filename [arguments]`" },
    { cmd: "help", min: 1, help: "Display help in Stata.\n\n**Syntax:** `help command_or_topic`" },
    { cmd: "log", min: 3, help: "Echo copy of session to file.\n\n**Syntax:** `log using filename [, append | replace]`" },
    { cmd: "pwd", min: 3, help: "Display current working directory.\n\n**Syntax:** `pwd`" },
    { cmd: "run", min: 3, help: "Execute commands from a file silently.\n\n**Syntax:** `run filename [arguments]`" },
    { cmd: "search", min: 3, help: "Search Stata documentation and internet.\n\n**Syntax:** `search word [word ...]`" },
    { cmd: "set", min: 3, help: "Set system parameters.\n\n**Syntax:** `set parameter value [, permanently]`" },
    { cmd: "timer", min: 3, help: "Time sections of code.\n\n**Syntax:** `timer on/off/list/clear #`" }
];

class StataCompletionProvider {
    constructor(vProvider) { this.variablesProvider = vProvider; }
    provideCompletionItems(document, position) {
        const varItems = this.variablesProvider.variables.map(v => {
            const item = new vscode.CompletionItem(v.name, vscode.CompletionItemKind.Variable);
            item.detail = `[${v.type}]${v.label}`;
            item.documentation = `Format: ${v.format}`;
            return item;
        });

        const cmdItems = stataHelpDocs.map(d => {
            const item = new vscode.CompletionItem(d.cmd, vscode.CompletionItemKind.Function);
            item.detail = "Stata Command";
            item.documentation = new vscode.MarkdownString(d.help);
            return item;
        });

        return varItems.concat(cmdItems);
    }
}

class StataHoverProvider {
    constructor(vProvider) { this.variablesProvider = vProvider; }
    provideHover(document, position) {
        const range = document.getWordRangeAtPosition(position);
        if (!range) return null;
        const word = document.getText(range);
        const wordLower = word.toLowerCase();

        const variable = this.variablesProvider.variables.find(v => v.name === word);
        if (variable) {
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**Variable:** \`${variable.name}\`\n\n**Label:** ${variable.label || '*none*'}\n\n**Type:** ${variable.type}\n\n**Format:** ${variable.format}`);
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

class StataDocumentSymbolProvider {
    provideDocumentSymbols(document, token) {
        const symbols = [];
        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const match = line.text.match(/^\s*\*\*\#\s*(.*)$/);
            if (match) {
                const name = match[1].trim() || "Bookmark";
                const symbol = new vscode.DocumentSymbol(name, '', vscode.SymbolKind.String, line.range, line.range);
                symbols.push(symbol);
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

                if (parsed.type === 'output') {
                    if (parsed.data.includes('[Stata Error]:')) {
                        resultsProvider.appendError(parsed.data);
                    } else {
                        resultsProvider.appendOutput(parsed.data);
                    }
                } else if (parsed.type === 'variables') {
                    variablesProvider.refresh(parsed.data);
                } else if (parsed.type === 'execution_finished') {
                    if (!activeDatasetPanel) {
                        vscode.commands.executeCommand('stata-ide.viewActiveDataset');
                    } else {
                        activeDatasetWebview.postMessage({ type: 'resetData' });
                        sendToBackend({ cmd: 'fetch_active', start: 0, end: 150, variables: activeVariablesSubset }).catch(() => { });
                    }
                } else if (parsed.type === 'stored_results') {
                    storedResultsProvider.refresh(parsed.data);
                } else if (parsed.type === 'graph') {
                    showGraphWebview(parsed.data, context);
                } else if (parsed.type === 'dataChunk' && activeDatasetWebview) {
                    activeDatasetWebview.postMessage({
                        type: 'chunkData',
                        data: parsed.data || [],
                        total: parsed.total || 0,
                        columns: parsed.columns || [],
                        frozenVars: Array.from(variablesProvider.frozenVars)
                    });
                } else if (parsed.type === 'error') {
                    historyProvider.markLastError();
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
        graphWebviewPanel = vscode.window.createWebviewPanel('stataGraph', 'Stata Graph Output', targetColumn, { enableScripts: true, localResourceRoots: [vscode.Uri.file(resourcesFolder)] });
        const chartIconUri = vscode.Uri.file(path.join(resourcesFolder, 'chart-file.svg'));
        graphWebviewPanel.iconPath = { light: chartIconUri, dark: chartIconUri };
        graphWebviewPanel.onDidDispose(() => { graphWebviewPanel = null; });
    }

    try {
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        const imgSrc = `data:image/png;base64,${base64Image}`;
        graphWebviewPanel.webview.html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:;">
                <style>body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: var(--vscode-editor-background); } img { max-width: 100%; max-height: 100%; object-fit: contain; }</style>
            </head>
            <body><img src="${imgSrc}" alt="Stata Graph" /></body>
            </html>
        `;
        graphWebviewPanel.reveal(graphWebviewPanel.viewColumn || vscode.ViewColumn.Active, true);
    } catch (err) { }
}

function getGridHtml(fetchCommandName) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            html, body { margin: 0; padding: 0; background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: monospace; height: 100%; overflow: hidden; display: flex; flex-direction: column; }
            #stats-bar { 
                flex: 0 0 auto; padding: 6px 12px; font-weight: bold; 
                background-color: var(--vscode-editor-background); 
                border-bottom: 1px solid var(--vscode-panel-border); 
                z-index: 10; font-size: 14px; 
                display: flex; justify-content: space-between; align-items: center; 
            }
            #unfreeze-btn {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none; padding: 4px 8px; cursor: pointer; border-radius: 2px;
                display: none; font-size: 12px;
            }
            #unfreeze-btn:hover { background: var(--vscode-button-hoverBackground); }
            
            #grid-wrapper { flex: 1 1 auto; position: relative; overflow: auto; background-color: var(--vscode-editor-background); }
            #scroll-sizer { position: absolute; top: 0; left: 0; width: 1px; z-index: -1; }
            
            table { border-collapse: collapse; table-layout: fixed; position: absolute; top: 0; left: 0; background-color: var(--vscode-editor-background); }
            th, td { 
                padding: 4px 8px; text-align: left; white-space: nowrap; 
                border-bottom: 1px solid var(--vscode-panel-border); 
                border-right: 1px solid var(--vscode-panel-border); 
                overflow: hidden; text-overflow: ellipsis;
                box-sizing: border-box;
            }
            
            th { 
                position: sticky; top: 0; 
                background-color: var(--vscode-editor-background); 
                z-index: 10; 
                box-shadow: inset 0 1px 0 var(--vscode-editor-background), inset 0 -1px 0 var(--vscode-panel-border);
                background-clip: padding-box; border-bottom: none; user-select: none;
                cursor: grab;
            }
            th:active { cursor: grabbing; }

            .resizer { position: absolute; right: 0; top: 0; bottom: 0; width: 5px; cursor: col-resize; z-index: 12; }
            .resizer:hover { background-color: var(--vscode-focusBorder); }
            
            tr:nth-child(even) td { background-color: var(--vscode-list-hoverBackground); }
            
            /* Apply sticky behavior and vertical blue border */
            .row-num-cell { position: sticky; left: 0; z-index: 1; box-shadow: inset -1px 0 0 var(--vscode-focusBorder); background-clip: padding-box; }
            .frozen-cell { position: sticky; z-index: 1; box-shadow: inset -1px 0 0 var(--vscode-focusBorder); background-clip: padding-box; }
            
            /* Headers MUST be 100% opaque to prevent scrolling bleed */
            th.frozen-cell, th.row-num-cell { 
                z-index: 11; 
                background-color: var(--vscode-editor-background) !important;
                box-shadow: inset -1px 0 0 var(--vscode-focusBorder), inset 0 1px 0 var(--vscode-editor-background), inset 0 -1px 0 var(--vscode-panel-border); 
            }
            
            /* Keep row numbers standard theme colors */
            tr:nth-child(even) td.row-num-cell { background-color: var(--vscode-list-hoverBackground); }
            tr:nth-child(odd) td.row-num-cell { background-color: var(--vscode-editor-background); }

            /* To prevent horizontal bleed under frozen columns, we apply a solid background, THEN tint it with an overlay */
            tr:nth-child(even) td.frozen-cell { 
                background-color: var(--vscode-list-hoverBackground);
                background-image: linear-gradient(rgba(130, 200, 255, 0.12), rgba(130, 200, 255, 0.12)); 
            }
            tr:nth-child(odd) td.frozen-cell { 
                background-color: var(--vscode-editor-background);
                background-image: linear-gradient(rgba(130, 200, 255, 0.06), rgba(130, 200, 255, 0.06)); 
            }

            #ctx-menu { display: none; position: fixed; z-index: 1000; background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border); box-shadow: 0 2px 4px rgba(0,0,0,0.5); padding: 4px 0; color: var(--vscode-menu-foreground); min-width: 120px; font-family: var(--vscode-font-family); font-size: 13px; }
            .ctx-menu-item { padding: 6px 12px; cursor: pointer; }
            .ctx-menu-item:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
        </style>
    </head>
    <body>
        <div id="stats-bar">
            <span id="stats-text">Loading dataset...</span>
            <button id="unfreeze-btn">Unfreeze All</button>
        </div>
        <div id="grid-wrapper">
            <div id="scroll-sizer"></div>
            <table id="data-table">
                <thead><tr id="header-row"></tr></thead>
                <tbody id="data-body"></tbody>
            </table>
        </div>
        <div id="ctx-menu"><div class="ctx-menu-item" id="ctx-freeze">Toggle Freeze</div></div>
        
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
            
            let contextMenuTargetCol = null;
            let dragSrcColIndex = null;
            
            const wrapper = document.getElementById('grid-wrapper');
            const sizer = document.getElementById('scroll-sizer');
            const header = document.getElementById('header-row');
            const body = document.getElementById('data-body');
            const statsText = document.getElementById('stats-text');
            const unfreezeBtn = document.getElementById('unfreeze-btn');
            const ctxMenu = document.getElementById('ctx-menu');
            
            document.addEventListener('click', () => ctxMenu.style.display = 'none');
            
            function notifyFrozen() {
                const fVars = colDefs.filter(c => c.frozen).map(c => c.name);
                vscode.postMessage({ command: 'updateFrozen', frozenVars: fVars });
                unfreezeBtn.style.display = fVars.length > 0 ? 'block' : 'none';
            }

            document.getElementById('ctx-freeze').addEventListener('click', () => {
                if(contextMenuTargetCol) {
                    contextMenuTargetCol.frozen = !contextMenuTargetCol.frozen;
                    colDefs.sort((a, b) => {
                        if (a.frozen === b.frozen) return 0;
                        return a.frozen ? -1 : 1;
                    });
                    notifyFrozen();
                    renderChunk(lastData);
                }
            });

            unfreezeBtn.addEventListener('click', () => {
                colDefs.forEach(c => c.frozen = false);
                notifyFrozen();
                renderChunk(lastData);
            });

            window.addEventListener('message', event => {
                if (event.data.type === 'chunkData') {
                    if (event.data.columns) {
                        const frozenSet = event.data.frozenVars ? new Set(event.data.frozenVars) : new Set(colDefs.filter(c => c.frozen).map(c => c.name));
                        
                        colDefs = event.data.columns.map(c => ({
                            name: c.name, 
                            width: colDefs.find(old => old.name === c.name)?.width || 120, 
                            frozen: frozenSet.has(c.name)
                        }));
                        colDefs.sort((a, b) => {
                            if (a.frozen === b.frozen) return 0;
                            return a.frozen ? -1 : 1;
                        });
                        notifyFrozen();
                    }
                    
                    totalObs = event.data.total || 0;
                    statsText.textContent = totalObs.toLocaleString() + ' observations, ' + colDefs.length + ' variables';
                    sizer.style.height = (totalObs * ROW_HEIGHT + 35) + 'px';
                    
                    renderedStart = requestedStart;
                    lastData = event.data.data || [];
                    renderChunk(lastData);
                } else if (event.data.type === 'resetData') {
                    renderedStart = 0;
                    requestedStart = 0;
                    lastData = [];
                    body.innerHTML = '';
                    header.innerHTML = '';
                    statsText.textContent = 'Loading dataset...';
                }
            });

            function renderChunk(rows) {
                if (!colDefs || colDefs.length === 0) {
                    header.innerHTML = '<th>No dataset loaded</th>';
                    body.innerHTML = '';
                    return;
                }

                let headerHtml = \`<th class="row-num-cell" style="width: \${ROW_NUMBER_WIDTH}px; min-width: \${ROW_NUMBER_WIDTH}px; max-width: \${ROW_NUMBER_WIDTH}px;">#</th>\`;
                let currentLeft = ROW_NUMBER_WIDTH;
                
                colDefs.forEach((c, idx) => {
                    let stickyStyle = '';
                    if (c.frozen) {
                        stickyStyle = \`position: sticky; left: \${currentLeft}px;\`;
                        currentLeft += c.width;
                    }
                    headerHtml += \`<th draggable="true" data-idx="\${idx}" class="\${c.frozen ? 'frozen-cell' : ''}" style="width: \${c.width}px; min-width: \${c.width}px; max-width: \${c.width}px; \${stickyStyle}">
                        \${c.name}
                        <div class="resizer" data-idx="\${idx}"></div>
                    </th>\`;
                });
                
                header.innerHTML = headerHtml;
                
                Array.from(header.querySelectorAll('th[draggable="true"]')).forEach(th => {
                    th.addEventListener('dragstart', e => {
                        dragSrcColIndex = parseInt(th.getAttribute('data-idx'));
                        e.dataTransfer.effectAllowed = 'move';
                    });
                    th.addEventListener('dragover', e => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                    });
                    th.addEventListener('drop', e => {
                        e.stopPropagation();
                        const tgtIndex = parseInt(th.getAttribute('data-idx'));
                        if (dragSrcColIndex !== null && dragSrcColIndex !== tgtIndex) {
                            const srcCol = colDefs[dragSrcColIndex];
                            const tgtCol = colDefs[tgtIndex];
                            
                            if (srcCol.frozen !== tgtCol.frozen) return; 
                            
                            const insertBefore = dragSrcColIndex > tgtIndex;
                            vscode.postMessage({ command: 'reorderVariable', src: srcCol.name, tgt: tgtCol.name, insertBefore: insertBefore });
                        }
                        return false;
                    });
                    th.addEventListener('contextmenu', e => {
                        e.preventDefault();
                        const idx = parseInt(th.getAttribute('data-idx'));
                        contextMenuTargetCol = colDefs[idx];
                        document.getElementById('ctx-freeze').textContent = contextMenuTargetCol.frozen ? 'Unfreeze Column' : 'Freeze Column';
                        ctxMenu.style.display = 'block';
                        ctxMenu.style.left = e.clientX + 'px';
                        ctxMenu.style.top = e.clientY + 'px';
                    });
                });

                Array.from(header.querySelectorAll('.resizer')).forEach(resizer => {
                    let startX, startW, colIdx;
                    resizer.addEventListener('mousedown', function(e) {
                        e.stopPropagation(); 
                        colIdx = parseInt(resizer.getAttribute('data-idx'));
                        startX = e.clientX;
                        startW = colDefs[colIdx].width;
                        document.addEventListener('mousemove', mouseMoveHandler);
                        document.addEventListener('mouseup', mouseUpHandler);
                    });
                    const mouseMoveHandler = function(e) {
                        const newW = Math.max(30, startW + (e.clientX - startX));
                        colDefs[colIdx].width = newW;
                        renderChunk(lastData); 
                    };
                    const mouseUpHandler = function() {
                        document.removeEventListener('mousemove', mouseMoveHandler);
                        document.removeEventListener('mouseup', mouseUpHandler);
                    };
                });

                let bodyHtml = '';
                const topPadding = renderedStart * ROW_HEIGHT;
                
                if (topPadding > 0) {
                    bodyHtml += \`<tr style="height: \${topPadding}px; background: transparent;"><td colspan="\${colDefs.length + 1}" style="border: none; padding: 0;"></td></tr>\`;
                }

                rows.forEach((r, idx) => {
                    let rowHtml = \`<tr style="height: \${ROW_HEIGHT}px">\`;
                    rowHtml += \`<td class="row-num-cell" style="width: \${ROW_NUMBER_WIDTH}px; min-width: \${ROW_NUMBER_WIDTH}px; max-width: \${ROW_NUMBER_WIDTH}px;">\${renderedStart + idx + 1}</td>\`;
                    
                    currentLeft = ROW_NUMBER_WIDTH;
                    colDefs.forEach(c => {
                        let stickyStyle = '';
                        if (c.frozen) {
                            stickyStyle = \`position: sticky; left: \${currentLeft}px;\`;
                            currentLeft += c.width;
                        }
                        const val = r[c.name] !== undefined && r[c.name] !== null ? r[c.name] : '';
                        rowHtml += \`<td class="\${c.frozen ? 'frozen-cell' : ''}" style="width: \${c.width}px; min-width: \${c.width}px; max-width: \${c.width}px; \${stickyStyle}" title="\${val}">\${val}</td>\`;
                    });
                    rowHtml += '</tr>';
                    bodyHtml += rowHtml;
                });
                
                body.innerHTML = bodyHtml;
            }
            
            wrapper.addEventListener('scroll', () => {
                const scrollTop = wrapper.scrollTop;
                const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 30);
                
                clearTimeout(scrollDebounce);
                scrollDebounce = setTimeout(() => {
                    if (Math.abs(startRow - requestedStart) > 40 && startRow < totalObs) {
                        requestedStart = startRow;
                        vscode.postMessage({ command: '${fetchCommandName}', start: startRow, end: startRow + 200 });
                    }
                }, 100);
            });
            
            requestedStart = 0;
            vscode.postMessage({ command: '${fetchCommandName}', start: 0, end: 200 });
        </script>
    </body>
    </html>`;
}

// ============================================================================
// EXTENSION ACTIVATION
// ============================================================================
function activate(context) {
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(new VariableDecorationProvider(variablesProvider)));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('stataResultsView', resultsProvider));

    context.subscriptions.push(vscode.window.registerCustomEditorProvider('stata-ide.dtaViewer', new StataOfflineViewerProvider(context), {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false
    }));

    variablesTreeView = vscode.window.createTreeView('stata-ide-variables-view', { treeDataProvider: variablesProvider, canSelectMany: true });
    context.subscriptions.push(variablesTreeView);

    vscode.window.createTreeView('stata-ide-stored-results-view', { treeDataProvider: storedResultsProvider });
    vscode.window.createTreeView('stata-ide-history-view', { treeDataProvider: historyProvider });

    const stataSelector = [
        { scheme: 'file', language: 'stata' },
        { pattern: '**/*.do' },
        { pattern: '**/*.ado' }
    ];

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(stataSelector, new StataCompletionProvider(variablesProvider)),
        vscode.languages.registerHoverProvider(stataSelector, new StataHoverProvider(variablesProvider)),
        vscode.languages.registerDocumentSymbolProvider(stataSelector, new StataDocumentSymbolProvider())
    );

    initializeBackend(context);

    const executeCodeCmd = vscode.commands.registerCommand('stata-ide.executeCode', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const selection = editor.selection;
        let code = '';
        let historyName = '';

        if (selection.isEmpty) {
            code = editor.document.getText();
            historyName = path.basename(editor.document.fileName) || 'Entire File';
        } else {
            code = editor.document.getText(selection);
            historyName = `Code chunk (Line ${selection.start.line + 1} to${selection.end.line + 1})`;
        }

        vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
        resultsProvider.appendCommand(`\n. ${code.split('\n')[0]}\n`);

        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        historyProvider.addCommand({ name: historyName, code: code, time: timeStr, isError: false });

        sendToBackend({ cmd: "execute", code: code });
    });

    const executeFileCmd = vscode.commands.registerCommand('stata-ide.executeFile', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const code = editor.document.getText();
        const fileName = path.basename(editor.document.fileName) || 'Untitled.do';

        vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
        resultsProvider.appendCommand(`\n. do "${editor.document.fileName}"\n`);

        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        historyProvider.addCommand({ name: fileName, code: code, time: timeStr, isError: false });

        sendToBackend({ cmd: "execute", code: code });
    });

    const stopExecutionCmd = vscode.commands.registerCommand('stata-ide.stopExecution', () => {
        if (stataProcess) {
            sendToBackend({ cmd: "interrupt" });
        }
    });

    const viewDatasetCmd = vscode.commands.registerCommand('stata-ide.viewActiveDataset', () => {
        if (activeDatasetPanel) {
            activeDatasetPanel.reveal(vscode.ViewColumn.Beside, true);
            return;
        }

        activeDatasetPanel = vscode.window.createWebviewPanel(
            'activeDatasetViewer', 'Stata: Active Dataset',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true }
        );

        const gridIconUri = vscode.Uri.file(path.join(context.extensionPath, 'resources', 'dta-file.png'));
        activeDatasetPanel.iconPath = { light: gridIconUri, dark: gridIconUri };

        activeDatasetWebview = activeDatasetPanel.webview;
        activeDatasetPanel.webview.html = getGridHtml('fetchActiveChunk');

        activeDatasetPanel.onDidDispose(() => { activeDatasetWebview = null; activeDatasetPanel = null; });
        activeDatasetPanel.webview.onDidReceiveMessage(e => {
            if (e.command === 'fetchActiveChunk') {
                sendToBackend({ cmd: 'fetch_active', start: e.start, end: e.end, variables: activeVariablesSubset });
            } else if (e.command === 'reorderVariable') {
                const position = e.insertBefore ? 'before' : 'after';
                const code = `order ${e.src}, ${position}(${e.tgt})`;
                vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
                resultsProvider.appendCommand(`\n. ${code}\n`);
                sendToBackend({ cmd: "execute", code: code });
            } else if (e.command === 'updateFrozen') {
                variablesProvider.setFrozen(e.frozenVars);
            }
        });
    });

    const filterLogic = async () => {
        const userInput = await vscode.window.showInputBox({ prompt: "Filter variables", value: variablesProvider.filterText });
        if (userInput !== undefined) variablesProvider.setFilter(userInput);
    };

    const filterVariablesCmd = vscode.commands.registerCommand('stata-ide.variables.filter', filterLogic);
    const filterActiveCmd = vscode.commands.registerCommand('stata-ide.variables.filterActive', filterLogic);
    const clearFilterCmd = vscode.commands.registerCommand('stata-ide.variables.clearFilter', () => { variablesProvider.setFilter(''); });
    const selectAllCmd = vscode.commands.registerCommand('stata-ide.variables.selectAll', () => { variablesProvider.selectAll(); });
    const unselectAllCmd = vscode.commands.registerCommand('stata-ide.variables.unselectAll', () => { variablesProvider.unselectAll(); });

    const browseSelectedCmd = vscode.commands.registerCommand('stata-ide.browseSelected', () => {
        let selected = variablesProvider.variables.filter(v => v.checkboxState === vscode.TreeItemCheckboxState.Checked).map(v => v.name);

        if (selected.length === 0 && variablesTreeView.selection.length > 0) {
            selected = variablesTreeView.selection.map(v => v.name);
        }

        if (selected.length === 0) {
            vscode.window.showInformationMessage("No variables selected or checked. Showing all.");
            activeVariablesSubset = [];
        } else {
            activeVariablesSubset = selected;
        }

        if (activeDatasetPanel) {
            activeDatasetWebview.postMessage({ type: 'resetData' });
            sendToBackend({ cmd: 'fetch_active', start: 0, end: 150, variables: activeVariablesSubset });
        } else {
            vscode.commands.executeCommand('stata-ide.viewActiveDataset');
        }
    });

    const insertVariableCmd = vscode.commands.registerCommand('stata-ide.variables.insert', (arg) => {
        const varName = (typeof arg === 'string') ? arg : (arg.name || '');
        if (isDoubleClick(`var_${varName}`)) {
            vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
            if (resultsProvider._view && varName) {
                resultsProvider._view.webview.postMessage({ type: 'insert_cli', text: varName });
            }
        }
    });

    const insertResultCmd = vscode.commands.registerCommand('stata-ide.results.insert', (arg) => {
        let text = "";
        if (typeof arg === 'string') text = arg;
        else if (arg && arg.key) text = arg.prefix === 'g' ? `$${arg.key}` : `\`${arg.prefix}(${arg.key})'`;

        if (isDoubleClick(`res_${text}`)) {
            vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
            if (resultsProvider._view && text) {
                resultsProvider._view.webview.postMessage({ type: 'insert_cli', text: text });
            }
        }
    });

    const populateHistoryCmd = vscode.commands.registerCommand('stata-ide.history.populate', (arg) => {
        const cmdText = (typeof arg === 'string') ? arg : (arg.code || '');
        if (isDoubleClick(`hist_${cmdText}`)) {
            vscode.commands.executeCommand('stataResultsView.focus').then(null, () => { });
            if (resultsProvider._view && cmdText) {
                resultsProvider._view.webview.postMessage({ type: 'insert_cli', text: cmdText });
            }
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
        executeCodeCmd, executeFileCmd, stopExecutionCmd, viewDatasetCmd, filterVariablesCmd, filterActiveCmd,
        clearFilterCmd, selectAllCmd, unselectAllCmd, browseSelectedCmd, insertVariableCmd,
        insertResultCmd, populateHistoryCmd, helpCmd, generateCodebookCmd
    );
}

function deactivate() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (stataProcess) stataProcess.kill();
}

module.exports = { activate, deactivate };