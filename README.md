# Stata IDE Integration for VS Code

[![Version](https://img.shields.io/badge/version-0.0.2-blue.svg)](https://github.com/your-username/stata-ide)
[![VS Code](https://img.shields.io/badge/VS%20Code-^1.80.0-007ACC.svg)](https://code.visualstudio.com/)

A high-performance, full-featured Stata workspace inside VS Code. Execute Stata code seamlessly, inspect variables and stored results, view virtualized datasets, and manage graphs within a unified editor environment.

---

## 🌟 Key Features

* **Interactive Code Execution:** Run selected code blocks or complete `.do` files with dedicated toolbar icons, context menus, or keyboard shortcuts.
* **Virtualized Active Dataset Viewer:** Browse in-memory data via a responsive virtualized grid. Features customizable column resizing, drag-and-drop reordering, and sticky column freezing.
* **Offline `.dta` Dataset Viewer:** Open and inspect static `.dta` binary files directly in VS Code without loading them into or overwriting your active Stata memory context.
* **Live Variables Manager:** Real-time tree view displaying active variables, data types, formats, and labels. Includes search filtering, quick CLI insertion, and visual indicators for frozen columns.
* **Stored Results Inspector:** Categorized view of active `r()`, `e()`, and `s()` returns alongside `$` global macros.
* **Automatic Graph Capture:** Automatically captures and renders output plots in an adjacent split tab upon code execution.
* **Interactive Stata Console:** Live terminal output channel equipped with an interactive input prompt for executing one-line commands.
* **Rich IntelliSense & Document Symbols:** Autocompletion for variables and commands, hover documentation cards, and document outline bookmarks (`**#`).

---

## ⌨️ Command Shortcuts

| Command | Action | Keybinding (Win/Linux) | Keybinding (Mac) |
| :--- | :--- | :--- | :--- |
| **Run Selection** | Executes highlighted code block | `Ctrl + R` | `Cmd + R` |
| **Run Entire File** | Runs full active `.do` file | `Ctrl  + D` | `Cmd + D` |
| **Focus Stata CLI** | Directs focus to Stata input prompt | `Ctrl + 1` | `Cmd + 1` |
| **Show Variables** | Focuses Variables Manager | `Ctrl + 4` | `Cmd + 4` |
| **View Active Dataset**| Opens Virtualized Data Grid | `Ctrl + 8` | `Cmd + 8` |

---

## ⚙️ Prerequisites & Configuration

### Prerequisites
1. **Stata**: Licensed installation of Stata (Stata 17+ recommended for PyStata support).
2. **Python**: Python 3.8+ with `pystata`, `pandas`, `numpy`, and `sfi` installed.

### Setup Steps
1. Open VS Code Settings (`Ctrl + ,` or `Cmd + ,`).
2. Search for **Stata IDE**.
3. Set your executable and installation paths:

```json
{
  "stata-ide.pythonPath": "C:\\Python312\\python.exe",
  "stata-ide.stataPath": "C:\\Program Files\\Stata18"
}