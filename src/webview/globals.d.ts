// VS Code WebView API — provided by the host at runtime. The bundled script
// calls acquireVsCodeApi() exactly once. Global by virtue of this file having
// no top-level imports/exports (ambient declaration).
declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void;
  setState: (state: unknown) => void;
  getState: () => unknown;
};
