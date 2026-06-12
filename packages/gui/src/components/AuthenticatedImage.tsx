import { useEffect, useState } from "react";

export function AuthenticatedImage({ src, token, className, alt }: { src: string; token: string | null; className?: string; alt: string }) {
  const [blobUrl, setBlobUrl] = useState("");
  useEffect(() => {
    let active = true;
    let url = "";
    fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.blob(); })
      .then((blob) => {
        if (!active) return;
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
      })
      .catch(() => setBlobUrl(""));
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [src, token]);
  return blobUrl ? <img src={blobUrl} alt={alt} className={className} /> : <div className={className} aria-label={alt} />;
}
