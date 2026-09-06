export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className="logo-mark"
    >
      <path
        d="M12 2.6c.8 1.8 2.8 3 2.8 5.2a2.8 2.8 0 1 1-5.6 0c0-1 .4-1.9 1-2.5.3.8.8 1.3 1.8 1.7 0-1.5 0-3 0-4.4Z"
        fill="currentColor"
      />
      <path
        d="M3 12.8h18v2.4h-6.8l1.4 2.1h3.4v2.3H5v-2.3h3.4l1.4-2.1H3v-2.4Z"
        fill="currentColor"
        opacity="0.55"
      />
    </svg>
  );
}
