import { useEffect, useRef, useState } from "react";

export function AuthenticatedImage({ src, token, className, alt }: { src: string; token: string | null; className?: string; alt: string }) {
  const [blobUrl, setBlobUrl] = useState("");
  // Keep the previous frame on screen while a new src loads — swapping only
  // after the fetch resolves avoids a blank flash on legitimate refreshes.
  const displayedUrlRef = useRef("");
  useEffect(() => {
    let active = true;
    fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.blob(); })
      .then((blob) => {
        if (!active) return;
        const url = URL.createObjectURL(blob);
        if (displayedUrlRef.current) URL.revokeObjectURL(displayedUrlRef.current);
        displayedUrlRef.current = url;
        setBlobUrl(url);
      })
      .catch(() => { if (active) setBlobUrl(""); });
    return () => {
      active = false;
    };
  }, [src, token]);
  useEffect(() => () => {
    if (displayedUrlRef.current) URL.revokeObjectURL(displayedUrlRef.current);
  }, []);
  return blobUrl ? <img src={blobUrl} alt={alt} className={className} /> : <div className={className} aria-label={alt} />;
}
