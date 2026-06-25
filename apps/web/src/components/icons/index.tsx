import React from "react";

interface IconProps {
  size?: number;
  className?: string;
}

function baseProps(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    className
  };
}

export function CalendarIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <rect x="2" y="3" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 6.5h12M5 1.8v2.4M11 1.8v2.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M4.5 6.2 8 9.8l3.5-3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M6.2 4.5 9.8 8l-3.6 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="m4 4 8 8M12 4 4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function CheckIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M3.5 8.2 6.8 11.2 12.5 4.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function WarningIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M8 2.1 14 13H2L8 2.1Z" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 5.3v4.1M8 11.7v.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function SearchIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5 13.5 13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function UploadIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M8 11.7V3.2M8 3.2 5.2 6M8 3.2 10.8 6M3 12.7h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function ArrowUpIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M8 13V3M3 8l5-5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ArrowDownIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M8 3v10M3 8l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function DashIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function SunIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MoonIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path
        d="M13 9.3A5.4 5.4 0 0 1 6.7 3a5.4 5.4 0 1 0 6.3 6.3Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CopilotIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path
        d="M8 2.2 9.1 5.6 12.5 6.7 9.1 7.8 8 11.2 6.9 7.8 3.5 6.7 6.9 5.6 8 2.2Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M12.4 10.8l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5.5-1.5Z" fill="currentColor" />
    </svg>
  );
}

/* Module / nav icons */
export function BoardIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <rect x="2" y="2.6" width="12" height="10.8" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 6.3h12M2 9.7h12" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function ChartIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M2.2 13.4h11.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M4 13V8.4M8 13V4.2M12 13V6.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function RouteIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <circle cx="4" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4 10.9V9.3A2.7 2.7 0 0 1 6.7 6.6H9.3A2.7 2.7 0 0 0 12 3.9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BuildingIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <rect x="3.2" y="2.4" width="9.6" height="11" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5.7 5h1.4M8.9 5h1.4M5.7 7.6h1.4M8.9 7.6h1.4M5.7 10.2h1.4M8.9 10.2h1.4M2.4 13.4h11.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PinIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path
        d="M8 13.8c0 0 4.3-3.8 4.3-7A4.3 4.3 0 0 0 3.7 6.8c0 3.2 4.3 7 4.3 7Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="6.7" r="1.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function GearIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <circle cx="8" cy="8" r="4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="1.7" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M12 8 13.6 8M10.83 10.83 11.96 11.96M8 12 8 13.6M5.17 10.83 4.04 11.96M4 8 2.4 8M5.17 5.17 4.04 4.04M8 4 8 2.4M10.83 5.17 11.96 4.04"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Backhaul exchange — two opposing arrows = the loaded-out / empty-back round trip. */
export function LoopIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M3 6h7.6M9 3.8 11.6 6 9 8.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 10H5.4M7 7.8 4.4 10 7 12.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ClipboardIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <rect x="3.4" y="2.8" width="9.2" height="10.8" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 2.2h4a.8.8 0 0 1 .8.8v.9a.8.8 0 0 1-.8.8H6a.8.8 0 0 1-.8-.8V3a.8.8 0 0 1 .8-.8Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5.8 7.6h4.4M5.8 10.1h2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function PencilIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M10.6 2.9 13.1 5.4M3 11.2 10.3 3.9a1.2 1.2 0 0 1 1.7 0l.1.1a1.2 1.2 0 0 1 0 1.7L4.8 13 2.4 13.6 3 11.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function TrashIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M3 4.4h10M6.3 4.4V3.2a.9.9 0 0 1 .9-.9h1.6a.9.9 0 0 1 .9.9v1.2M4.3 4.4l.6 8a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.6-8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.6 7v3.4M9.4 7v3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function PlusIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function LockIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.4 7V5.4a2.6 2.6 0 0 1 5.2 0V7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function InfoIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 7.2v3.6M8 5v.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function KeyIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <circle cx="5.4" cy="5.4" r="2.9" stroke="currentColor" strokeWidth="1.4" />
      <path d="m7.5 7.5 5 5M10.5 10.5l1.2-1.2M12 12l1.2-1.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SlidersIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M3 4.5h6M11.5 4.5H13M3 11.5h2.5M8 11.5h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="10.2" cy="4.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6.4" cy="11.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function HistoryIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M2.6 8a5.4 5.4 0 1 1 1.6 3.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M2.4 11.6 2 8.6l3 .5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 5.2V8l2 1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SparkIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M8 2.2 9.1 5.6 12.5 6.7 9.1 7.8 8 11.2 6.9 7.8 3.5 6.7 6.9 5.6 8 2.2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M12.4 11.2l.4 1.2 1.2.4-1.2.4-.4 1.2-.4-1.2-1.2-.4 1.2-.4.4-1.2Z" fill="currentColor" />
    </svg>
  );
}

export function SeatIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M5 2.5v6.5h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 9 3.6 13.5M10 9l1.4 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function HookIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <path d="M8 2.5v5a2.5 2.5 0 0 1-2.5 2.5H4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="10.5" cy="11.5" r="2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function GripIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...baseProps(size, className)}>
      <circle cx="6" cy="4" r="0.9" fill="currentColor" />
      <circle cx="10" cy="4" r="0.9" fill="currentColor" />
      <circle cx="6" cy="8" r="0.9" fill="currentColor" />
      <circle cx="10" cy="8" r="0.9" fill="currentColor" />
      <circle cx="6" cy="12" r="0.9" fill="currentColor" />
      <circle cx="10" cy="12" r="0.9" fill="currentColor" />
    </svg>
  );
}
