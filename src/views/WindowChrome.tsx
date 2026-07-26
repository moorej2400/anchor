/** Top window chrome: brand mark, centered active-folder path, control dots. */
interface WindowChromeProps {
  activePath: string | null;
}

export function WindowChrome({ activePath }: WindowChromeProps) {
  return (
    <div className="chrome" data-tauri-drag-region>
      <div className="chrome__brand">
        <div className="chrome__mark" />
        <span className="chrome__name">Anchor</span>
      </div>
      <div className="chrome__path">{activePath ?? ""}</div>
      <div className="chrome__dots">
        <span className="chrome__dot" />
        <span className="chrome__dot" />
        <span className="chrome__dot" />
      </div>
    </div>
  );
}
