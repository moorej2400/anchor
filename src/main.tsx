import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./components/lib/styles";
import "./styles/app.css";
import App from "./App";
import { AnchorProvider } from "./app/store";
import { Gallery } from "./components/Gallery";

// Dev-only component gallery: open with `#gallery` in the URL.
const showGallery = import.meta.env.DEV && window.location.hash === "#gallery";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {showGallery ? (
      <Gallery />
    ) : (
      <AnchorProvider>
        <App />
      </AnchorProvider>
    )}
  </React.StrictMode>,
);
