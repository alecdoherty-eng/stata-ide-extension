# Stata IDE Integration

A high-performance Stata integration extension for the Antigravity IDE and VS Code.

## Features
- **UI Execution Toolbar:** Run your entire `.do` file or selected code blocks directly via buttons in the editor title menu.
- **Variables Sidebar:** A dynamic sidebar panel that displays the names, types, and labels of all variables currently in Stata's memory.
- **High-Performance Data Viewer:** A unified, dark-mode virtualized data viewer for both static `.dta` files and live in-memory datasets utilizing AG Grid and lazy-loading via an IPC pipeline.
- **Live Console Output:** Real-time feedback from the Stata engine in the Output Channel.

## Prerequisites
- **Python**: Must have Python installed with `PyStata` and `pandas`.
- **Stata**: A valid licensed Stata installation (Stata 17+ recommended for PyStata).

## Configuration
Before running, configure the paths to your Python and Stata installations in your workspace or user settings:

1. Open Settings (`Ctrl+,`).
2. Search for `Stata IDE`.
3. Set `stata-ide.pythonPath` to your Python executable (e.g., `C:\Python312\python.exe` or `python`).
4. Set `stata-ide.stataPath` to your Stata installation directory (e.g., `C:\Program Files\Stata17`).

## Development Instructions

1. **Install Dependencies**
   ```bash
   npm install