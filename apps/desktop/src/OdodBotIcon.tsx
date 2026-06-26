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

export function SleepingOdodBotIcon({ size = 24, strokeWidth = 2 }: OdodBotIconProps) {
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
      className="sleepingBotIcon"
      aria-hidden="true"
    >
      <line x1="9" y1="7.25" x2="9" y2="4.25" />
      <circle cx="9" cy="3.25" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="14.25" r="6.5" />
      <path d="M7.8 13.3c0.8 0.7 1.6 0.7 2.4 0" />
      <path d="M11.9 13.3c0.8 0.7 1.6 0.7 2.4 0" />
      <path className="sleepingBotZ sleepingBotZ--large" d="M16.1 5.3h3.1l-3.1 3h3.1" />
      <path className="sleepingBotZ sleepingBotZ--small" d="M18.7 1.8h2.6l-2.6 2.5h2.6" />
      <path className="sleepingBotZ sleepingBotZ--tiny" d="M14.2 2.9h2.1l-2.1 2h2.1" />
    </svg>
  );
}
