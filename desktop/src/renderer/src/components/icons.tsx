/**
 * Inline SVG icons on a 24x24 grid, stroked with `currentColor` so they inherit
 * state colours from the button they sit in.
 */

type IconProps = { size?: number; className?: string }

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

export const MicIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="9" y="2" width="6" height="11" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
  </svg>
)

export const MicOffIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M15 9V5a3 3 0 0 0-5.9-.7M9 9v1a3 3 0 0 0 4.6 2.5" />
    <path d="M5 10a7 7 0 0 0 10.8 5.9M19 10a7 7 0 0 1-.9 3.4M12 17v5" />
    <path d="M3 3l18 18" />
  </svg>
)

export const CameraIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="2" y="6" width="14" height="12" rx="2.5" />
    <path d="M16 11l6-3.5v9L16 13z" />
  </svg>
)

export const CameraOffIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M9 6h4.5A2.5 2.5 0 0 1 16 8.5V11M16 13v2.5a2.5 2.5 0 0 1-2.5 2.5H4.5A2.5 2.5 0 0 1 2 15.5v-7A2.5 2.5 0 0 1 4.5 6" />
    <path d="M16 11l6-3.5v9l-3-1.7" />
    <path d="M3 3l18 18" />
  </svg>
)

export const ScreenIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
)

export const ScreenOffIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M22 13V6a2 2 0 0 0-2-2H8M2 8v7a2 2 0 0 0 2 2h12" />
    <path d="M8 21h8M12 17v4M3 3l18 18" />
  </svg>
)

export const MixerIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M6 20V14M6 10V4M12 20v-8M12 8V4M18 20v-4M18 12V4" />
    <path d="M3 14h6M9 8h6M15 16h6" />
  </svg>
)

export const SettingsIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9 2 2 0 1 1 0 4 1.7 1.7 0 0 0-1.5 1.5z" />
  </svg>
)

export const LeaveIcon = ({ size = 20, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M16 17l5-5-5-5M21 12H9M12 19H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" />
  </svg>
)

export const PlusIcon = ({ size = 18, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const PinIcon = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M12 17v5M8.5 3h7l-1 6 3 3v2H6.5v-2l3-3z" />
  </svg>
)

export const SpeakerIcon = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M11 5L6 9H2v6h4l5 4z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
  </svg>
)

export const SpeakerOffIcon = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M11 5L6 9H2v6h4l5 4z" />
    <path d="M22 9l-6 6M16 9l6 6" />
  </svg>
)

export const CloseIcon = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
)

export const MinimizeIcon = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M5 12h14" />
  </svg>
)

export const MaximizeIcon = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </svg>
)

export const AlertIcon = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3.5 22 20H2z" />
    <path d="M12 10v4M12 17h.01" />
  </svg>
)

export const RefreshIcon = ({ size = 14, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <path d="M20 11a8 8 0 0 0-13.7-5.3L3 9" />
    <path d="M4 13a8 8 0 0 0 13.7 5.3L21 15" />
    <path d="M3 4v5h5M21 20v-5h-5" />
  </svg>
)

export const SteamIcon = ({ size = 16, className }: IconProps) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="15.5" cy="9" r="2.6" />
    <circle cx="8" cy="15" r="2.2" />
    <path d="M2.6 15.6l3.3 1.3M10.2 13.4l3-2.6" />
  </svg>
)
