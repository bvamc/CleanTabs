import type { ReactNode } from "react";
import { Button } from "./button";

interface AlertDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

export function AlertDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  children,
  onConfirm,
  onCancel
}: AlertDialogProps) {
  if (!open) return null;

  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        aria-describedby="dialog-description"
        aria-labelledby="dialog-title"
        aria-modal="true"
        className="dialog"
        role="dialog"
      >
        <div className="dialog-header">
          <h2 id="dialog-title">{title}</h2>
          <p id="dialog-description">{description}</p>
        </div>
        {children ? <div className="dialog-body">{children}</div> : null}
        <div className="dialog-footer">
          <Button variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
