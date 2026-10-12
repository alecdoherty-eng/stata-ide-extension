# Stata IDE Integration for VS Code

[![Version](https://img.shields.io/badge/version-1.0.1-blue.svg)](https://github.com/your-username/stata-ide)
[![VS Code](https://img.shields.io/badge/VS%20Code-^1.80.0-007ACC.svg)](https://code.visualstudio.com/)

A high-performance, full-featured Stata workspace inside VS Code. Execute Stata code seamlessly, inspect variables and stored results, view virtualized datasets, and manage graphs within a unified editor environment.

---

## 🌟 Key Features

* **Interactive Code Execution:** Run selected code blocks, entire `.do` files, or localized **CodeLens chunks** directly from the editor.
* **Advanced Code Beautifier (NEW):** Format your `.do` files (`Alt+Shift+F`) to vertically align consecutive `=` assignments, snap variables to tab stops after `gen`/`replace`, standardize operator padding, indent line continuations (`///`), and automatically wrap long graphics commands.
* **Context-Aware IntelliSense (UPDATED):** Auto-completion dynamically prioritizes active in-memory variables when typing data commands, filters command-specific options after commas, and provides hover documentation for over 90 native Stata commands.
* **Live Variable Sparklines (NEW):** Hover over any variable in your code to instantly view an SVG distribution histogram and live summary statistics (obs, mean, min, max, std. dev).
* **Native Outline Navigation (NEW):** Jump effortlessly through large scripts using the VS Code Outline panel and breadcrumbs, automatically populated by `**#` bookmarks and `program define` blocks.
* **Virtualized Active Dataset Viewer:** Browse in-memory data via a highly responsive grid. Features in-grid sorting, drag-and-drop reordering, TSV clipboard exporting, and sticky column freezing.
* **Visual Query Builder (NEW):** Filter dataset rows using a rich, auto-compiling node UI that supports nested `AND`/`OR` conditions without writing raw Stata syntax.
* **Live Column Statistics (NEW):** Expand the dataset grid headers to instantly reveal dynamically rendered column profiles, handling categorical string analysis, date formatting, and continuous numeric histograms.
* **Offline `.dta` Dataset Viewer:** Open and inspect static `.dta` binary files directly in VS Code without loading them into or overwriting your active Stata memory context.
* **Live Variables Manager:** Real-time tree view displaying active variables, data types, formats, and labels. Includes search filtering, quick CLI insertion, and visual indicators for frozen columns.
* **Stored Results Inspector:** Categorized view of active `r()`, `e()`, and `s()` returns alongside `$` global macros.
* **Automatic Graph Capture:** Automatically captures and renders output plots in an adjacent split tab upon code execution.
* **Interactive Stata Console:** Live terminal output channel equipped with a persistent execution history stack.
* **Status Bar Engine Indicator:** Real-time visual feedback on the Stata backend state (Ready, Running, Offline).

---

## ⌨️ Command Shortcuts

| Command | Action | Keybinding (Win/Linux) | Keybinding (Mac) |
| :--- | :--- | :--- | :--- |
| **Run Selection** | Executes highlighted code block | `Ctrl + R` | `Cmd + R` |
| **Run Entire File** | Runs full active `.do` file | `Ctrl + D` | `Cmd + D` |
| **Format Document** | Beautifies active `.do` file | `Alt + Shift + F` | `Option + Shift + F` |
| **Focus Stata CLI** | Directs focus to Stata input prompt | `Ctrl + 1` | `Cmd + 1` |
| **Show Variables** | Focuses Variables Manager | `Ctrl + 4` | `Cmd + 4` |
| **View Active Dataset**| Opens Virtualized Data Grid | `Ctrl + 8` | `Cmd + 8` |

---

## ⚙️ Prerequisites & Configuration

The Stata IDE backend requires Python and Stata to communicate via the proprietary `sfi` (Stata Function Interface) module. This module cannot be downloaded from the internet—it must be linked locally from your Stata installation directory. Both applications must also share the same 64-bit architecture.

### 1. Verify 64-Bit Architecture Matches
If you attempt to bridge a 32-bit Python environment with a 64-bit Stata installation, the extension will fail to load the Stata engine. 

*   **Check Python:** Open your terminal or command prompt and run:
    ```bash
    python -c "import platform; print(platform.architecture()[0])"
    ```
    *This must output `64bit`.*
*   **Check Stata:** Open your Stata GUI and type `about` in the command window. The output will explicitly state whether you are running a 64-bit version (e.g., *64-bit for Windows* or *Mac Intel 64-bit*).

### 2. Install PyStata (and SFI) Locally
Do **not** run `pip install sfi` or `pip install pystata`. The public PyPI repositories do not contain StataCorp's proprietary libraries. You must point `pip` directly to the `utilities` folder inside your local Stata installation.

Open your terminal and run the command matching your operating system (adjust the path if you installed Stata in a custom location):

**Windows:**
```cmd
pip install "C:\Program Files\Stata18\utilities\pystata"