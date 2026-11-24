import Link from "next/link";

export function BackButton({ href, label, ariaLabel }: { href: string; label: string; ariaLabel?: string }) {
  return <Link href={href} aria-label={ariaLabel} className="back-btn"><span aria-hidden="true" className="back-arrow">←</span><span>{label}</span></Link>;
}
