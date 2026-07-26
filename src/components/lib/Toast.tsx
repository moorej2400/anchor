/** Bottom-center transient confirmation ("Session ID copied"). */
interface ToastProps {
  text: string;
}

export function Toast({ text }: ToastProps) {
  return (
    <div className="a-toast" role="status">
      <span className="a-toast__check">✓</span>
      {text}
    </div>
  );
}
