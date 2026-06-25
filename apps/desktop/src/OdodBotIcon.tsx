type OdodBotIconProps = {
  size?: number;
  strokeWidth?: number;
};

export function OdodBotIcon({ size = 24, strokeWidth = 2 }: OdodBotIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="6.5" x2="12" y2="2.5" />
      <circle cx="12" cy="1.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="13.5" r="7" />
      <line x1="9.75" y1="12.5" x2="9.75" y2="15.5" />
      <line x1="14.25" y1="12.5" x2="14.25" y2="15.5" />
    </svg>
  );
}
