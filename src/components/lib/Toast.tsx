/** Bottom-center transient confirmation ("Session ID copied"). */
import { Icon } from "../Icon";

interface ToastProps {
  text: string;
}

export function Toast({ text }: ToastProps) {
  return (
    <div className="a-toast" role="status">
      <span className="a-toast__check"><Icon name="check" size={13} /></span>
      {text}
    </div>
  );
}
