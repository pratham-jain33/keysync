"use client";

// Next.js re-mounts this template on every navigation, so wrapping children
// in a fade-up gives a gentle page-transition between home and practice views.
// Motion collapses to a static frame under prefers-reduced-motion (globals.css).
export default function Template({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="animate-fade-up">{children}</div>;
}
