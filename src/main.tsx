import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import { IconContext } from "@phosphor-icons/react";
import "@fontsource-variable/inter";
import "@/lib/i18n";
import App from "./App";
import { UpdateToast } from "./components/ui/update-toast";
import "./index.css";

// HashRouter: yuki is a static site where only index.html exists — hash
// routes keep every page (#/stats, #/read/:id) a real, reloadable URL
// without any server rewrite rules.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IconContext.Provider value={{ weight: "bold" }}>
      <HashRouter>
        <App />
      </HashRouter>
      <UpdateToast />
    </IconContext.Provider>
  </StrictMode>,
);
