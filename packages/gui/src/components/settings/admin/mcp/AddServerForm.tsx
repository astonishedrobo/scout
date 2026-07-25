import { useState } from "react";
import {
  Button,
  Field,
  Input,
  PasswordInput,
  Segmented,
  SettingsGroup,
  SettingsRow,
} from "../../../ui";
import { slugify, type Transport } from "./types";

export interface NewServer {
  name: string;
  id: string;
  transport: Transport;
  url?: string;
  image?: string;
  command: string[];
  args: string[];
  shared_credential?: string;
  availability: "everyone" | "selected";
  enabled: true;
}

/**
 * The add-integration form.
 *
 * Two changes from the version that lived permanently at the top of the panel.
 * It is now behind a button, because installing a server is a rare act and the
 * form was pushing the list of installed servers — the thing an admin actually
 * came to look at — below the fold. And validation is inline `invalid` state on
 * the field at fault rather than a message in the surface-level status region,
 * which said "Enter an MCP URL" without indicating which field that was.
 */
export function AddServerForm({
  onSubmit,
  onCancel,
  saving,
}: {
  onSubmit: (server: NewServer) => Promise<boolean>;
  onCancel: () => void;
  saving: boolean;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<Transport>("streamable_http");
  const [url, setUrl] = useState("");
  const [image, setImage] = useState("");
  const [command, setCommand] = useState("");
  const [credential, setCredential] = useState("");
  const [availability, setAvailability] = useState<"everyone" | "selected">("everyone");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const id = slugify(name);

  const submit = async () => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Give the integration a name.";
    else if (!id) next.name = "The name needs at least one letter or number.";
    if (transport === "streamable_http" && !url.trim()) next.url = "Enter the MCP endpoint URL.";
    if (transport === "container_stdio") {
      if (!image.trim()) next.image = "Enter a container image.";
      else if (!image.includes("@sha256:"))
        // A mutable tag means the image can change under a running deployment,
        // which is the whole reason the backend requires a digest.
        next.image = "The image must be digest-pinned (…@sha256:…).";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const parts = command.trim().split(/\s+/).filter(Boolean);
    const ok = await onSubmit({
      name: name.trim(),
      id,
      transport,
      url: transport === "streamable_http" ? url.trim() : undefined,
      image: transport === "container_stdio" ? image.trim() : undefined,
      command: transport === "container_stdio" && parts.length ? [parts[0]] : [],
      args: transport === "container_stdio" ? parts.slice(1) : [],
      shared_credential:
        transport === "streamable_http" ? credential.trim() || undefined : undefined,
      availability,
      enabled: true,
    });
    if (ok) onCancel();
  };

  return (
    <SettingsGroup
      label="Add an integration"
      description="Install a remote MCP server, or a digest-pinned container. Users enable allowed integrations in Connections."
      action={
        <div className="flex items-center gap-2">
          <Button variant="ghost" surface="panel" size="compact" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="outlined" surface="panel" size="compact" onClick={submit} loading={saving}>
            Add
          </Button>
        </div>
      }
    >
      <div className="space-y-3.5 px-4 py-3.5">
        <Field
          label="Name"
          error={errors.name}
          // The id is derived, not entered, and it is what appears in tool names
          // and API paths — so it is shown before the server is created.
          hint={id ? `Shown to users. Its id will be “${id}”.` : "Shown to users."}
        >
          {({ id: fieldId }) => (
            <Input
              id={fieldId}
              size="sm"
              value={name}
              invalid={Boolean(errors.name)}
              onChange={(e) => setName(e.target.value)}
              placeholder="Asana"
            />
          )}
        </Field>

        <SettingsRow
          label="Connection"
          description="How Scout reaches the server."
          className="!px-0"
          control={
            <Segmented
              value={transport}
              onChange={setTransport}
              label="Transport"
              options={[
                { value: "streamable_http", label: "Remote" },
                { value: "container_stdio", label: "Container" },
              ]}
            />
          }
        />

        {transport === "streamable_http" ? (
          <>
            <Field label="URL" error={errors.url}>
              {({ id: fieldId }) => (
                <Input
                  id={fieldId}
                  size="sm"
                  value={url}
                  invalid={Boolean(errors.url)}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://mcp.example.com/sse"
                />
              )}
            </Field>
            <Field
              label="Shared token"
              hint="Optional. Used for every user unless they save their own."
            >
              {({ id: fieldId }) => (
                <PasswordInput
                  id={fieldId}
                  size="sm"
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                  placeholder="Optional"
                />
              )}
            </Field>
          </>
        ) : (
          <>
            <Field label="Image" error={errors.image} hint="Must be digest-pinned.">
              {({ id: fieldId }) => (
                <Input
                  id={fieldId}
                  size="sm"
                  value={image}
                  invalid={Boolean(errors.image)}
                  onChange={(e) => setImage(e.target.value)}
                  placeholder="ghcr.io/org/server@sha256:…"
                  className="font-mono"
                />
              )}
            </Field>
            <Field label="Command" hint="Optional override, space separated.">
              {({ id: fieldId }) => (
                <Input
                  id={fieldId}
                  size="sm"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="node server.js --stdio"
                  className="font-mono"
                />
              )}
            </Field>
          </>
        )}

        <SettingsRow
          label="Availability"
          description="Who may enable it."
          className="!px-0"
          control={
            <Segmented
              value={availability}
              onChange={setAvailability}
              label="Availability"
              options={[
                { value: "everyone", label: "Everyone" },
                { value: "selected", label: "Selected" },
              ]}
            />
          }
        />
      </div>
    </SettingsGroup>
  );
}
