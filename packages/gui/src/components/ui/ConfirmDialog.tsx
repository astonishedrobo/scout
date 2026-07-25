import { CenterModal } from "./CenterModal";
import { Button } from "./Button";

export interface ConfirmRequest {
  title: string;
  /** What will happen, in plain terms. Say if it cannot be undone. */
  body: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}

/**
 * One confirmation dialog, driven by a request object.
 *
 * Consequential mutations were inconsistent: a proper modal for shared-file
 * delete, `window.confirm` for MCP removal, and nothing at all for disabling a
 * server, flipping a tool to write access, or downgrading a user's permission
 * profile or capacity group.
 */
export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest | null;
  onClose: () => void;
}) {
  return (
    <CenterModal open={!!request} onClose={onClose} title={request?.title} maxWidth="sm">
      <div className="space-y-3 px-4 py-3.5">
        <p className="text-label leading-relaxed text-scout-muted">{request?.body}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" surface="panel" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="filled"
            surface="panel"
            // `destructive` used to change only the button's *label*, so a
            // delete confirmation looked exactly like an innocuous one.
            tone={request?.destructive ? "danger" : undefined}
            onClick={async () => {
              await request?.onConfirm();
              onClose();
            }}
          >
            {request?.confirmLabel ?? (request?.destructive ? "Delete" : "Confirm")}
          </Button>
        </div>
      </div>
    </CenterModal>
  );
}
