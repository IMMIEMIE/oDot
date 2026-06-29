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
      <line x1="12" y1="6.5" x2="12" y2="2.5" />
      <circle cx="12" cy="1.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="13.5" r="7" />
      <path d="M8.65 13.2c0.7 0.55 1.5 0.55 2.2 0" />
      <path d="M13.15 13.2c0.7 0.55 1.5 0.55 2.2 0" />
      <g className="sleepingBotZ">
        <path d="M16.1 5.3h3.1l-3.1 3h3.1">
          <animate
            attributeName="opacity"
            values="0;1;0"
            keyTimes="0;0.34;1"
            dur="2.1s"
            repeatCount="indefinite"
          />
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 1.2;0 0;1.2 -2.1"
            keyTimes="0;0.34;1"
            dur="2.1s"
            repeatCount="indefinite"
          />
        </path>
        <path d="M18.7 1.8h2.6l-2.6 2.5h2.6">
          <animate
            attributeName="opacity"
            values="0;0;1;0"
            keyTimes="0;0.16;0.48;1"
            dur="2.1s"
            repeatCount="indefinite"
          />
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 1.2;0 1.2;0.9 0;1.8 -2.4"
            keyTimes="0;0.16;0.48;1"
            dur="2.1s"
            repeatCount="indefinite"
          />
        </path>
        <path d="M14.2 2.9h2.1l-2.1 2h2.1">
          <animate
            attributeName="opacity"
            values="0;0;1;0"
            keyTimes="0;0.3;0.62;1"
            dur="2.1s"
            repeatCount="indefinite"
          />
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 1;0 1;0.8 -0.2;1.5 -2"
            keyTimes="0;0.3;0.62;1"
            dur="2.1s"
            repeatCount="indefinite"
          />
        </path>
      </g>
    </svg>
  );
}

export function WorkingOdodBotIcon({ size = 24, strokeWidth = 2 }: OdodBotIconProps) {
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
      className="workingBotIcon"
      aria-hidden="true"
    >
      <line x1="12" y1="6.5" x2="12" y2="2.5" />
      <circle cx="12" cy="1.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="13.5" r="7" />
      <polyline points="8.9 11.8 10.7 13.5 8.9 15.2" />
      <polyline points="15.1 11.8 13.3 13.5 15.1 15.2" />
      <g className="workingBotSweat">
        <path d="M19.05 6.9c0.95 1.2 1.45 2.1 1.45 2.85a1.45 1.45 0 0 1-2.9 0c0-0.75 0.5-1.65 1.45-2.85z">
          <animate
            attributeName="opacity"
            values="0;0.95;0.95;0"
            keyTimes="0;0.24;0.72;1"
            dur="1.05s"
            repeatCount="indefinite"
          />
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 -1;0 0;0 1.9;0 3.4"
            keyTimes="0;0.24;0.72;1"
            dur="1.05s"
            repeatCount="indefinite"
          />
        </path>
      </g>
    </svg>
  );
}
