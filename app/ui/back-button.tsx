import Link from "next/link";

export function BackButton({ href, label }: { href: string; label: string }) {
  return <Link href={href} className="back-btn"><span aria-hidden="true" className="back-arrow">←</span><span>{label}</span></Link>;
}
