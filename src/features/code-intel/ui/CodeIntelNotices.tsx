import { LAYER } from "../../../shared/lib/layers";
import {
  dismissCodeIntel,
  useCodeIntelNotices,
} from "../model/codeIntelNotices";

/** Compile results and code-intelligence errors, bottom left. */
export function CodeIntelNotices() {
  const notices = useCodeIntelNotices();
  if (!notices.length) return null;
  return (
    <div
      className="fixed bottom-4 left-4 flex max-w-md flex-col gap-2"
      style={{ zIndex: LAYER.toast }}
    >
      {notices.map((n) => (
        <div
          key={n.id}
          role={n.error ? "alert" : "status"}
          className={`flex items-start gap-3 rounded-xl border bg-background-base px-3 py-2 text-[12px] shadow-xl ${
            n.error
              ? "border-red-400/30 text-red-400"
              : "border-content/10 text-content/80"
          }`}
        >
          <span className="min-w-0 whitespace-pre-wrap break-words">
            {n.message}
          </span>
          <button
            type="button"
            onClick={() => dismissCodeIntel(n.id)}
            className="shrink-0 text-content/50 hover:text-content"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
