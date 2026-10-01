import Link from "next/link";

/**
 * KeySync logo mark: three rounded "key" bars — ivory outer pair framing a
 * taller brass center key, the note that is in sync. Bottom-aligned and
 * symmetric so it never reads lopsided at any size.
 */
export function LogoMark({
  size = 28,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="KeySync"
      className={className}
    >
      <rect x="5" y="11" width="6" height="15" rx="3" fill="#f3f1ec" opacity="0.9" />
      <rect x="13" y="6" width="6" height="20" rx="3" fill="#e6b45c" />
      <rect x="21" y="11" width="6" height="15" rx="3" fill="#f3f1ec" opacity="0.9" />
    </svg>
  );
}

/** Wordmark rendered in Fraunces: "Key" in ivory, "Sync" in brass. */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`font-display font-semibold tracking-tight ${className}`}>
      Key<span className="text-accent">Sync</span>
    </span>
  );
}

/** Mark + wordmark lockup. Links home unless `asLink` is false. */
export function Brand({
  size = 28,
  wordClassName = "text-lg",
  asLink = true,
}: {
  size?: number;
  wordClassName?: string;
  asLink?: boolean;
}) {
  const inner = (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark size={size} />
      <Wordmark className={wordClassName} />
    </span>
  );
  if (!asLink) return inner;
  return (
    <Link
      href="/"
      aria-label="KeySync home"
      className="inline-flex items-center rounded-xl focus-visible:outline-none"
    >
      {inner}
    </Link>
  );
}

/**
 * Line-art keyboard used for empty states. Faint ivory keys with a single
 * brass key lit, echoing the logo. Decorative only.
 */
export function EmptyKeys({ className = "" }: { className?: string }) {
  const whites = [0, 1, 2, 3, 4, 5, 6];
  // Black keys sit between selected white keys (standard octave layout).
  const blacks = [0, 1, 3, 4, 5];
  const litWhite = 3;
  return (
    <svg
      viewBox="0 0 196 96"
      fill="none"
      role="img"
      aria-hidden="true"
      className={className}
    >
      {whites.map((i) => (
        <rect
          key={`w${i}`}
          x={8 + i * 26}
          y={20}
          width={24}
          height={64}
          rx={4}
          fill={i === litWhite ? "rgba(230,180,92,0.14)" : "transparent"}
          stroke={i === litWhite ? "#e6b45c" : "#3a3a44"}
          strokeWidth={1.5}
        />
      ))}
      {blacks.map((i) => (
        <rect
          key={`b${i}`}
          x={8 + (i + 1) * 26 - 8}
          y={20}
          width={16}
          height={38}
          rx={3}
          fill="#0e0e12"
          stroke="#3a3a44"
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}
