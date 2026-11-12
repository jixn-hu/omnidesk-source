import type { ButtonHTMLAttributes, ComponentProps } from 'react'
import Icon from './Icon'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  phase?: 'idle' | 'busy' | 'success'
  icon?: ComponentProps<typeof Icon>['name']
  successLabel?: string
}

// Business code owns the outcome, including cancellation and first Agent report.
export default function ActionButton({ phase = 'idle', icon = 'arrow', successLabel, children, disabled, className = 'btn', type = 'button', ...props }: Props) {
  return <button {...props} type={type} className={`${className} action-button`} data-phase={phase}
    disabled={disabled || phase === 'busy'} aria-busy={phase === 'busy' || undefined}>
    <span className="action-icon-slot" aria-hidden="true">
      <span className="action-icon-idle"><Icon name={icon} size={15} /></span>
      <span className="action-icon-busy"><Icon name="refresh" size={15} /></span>
      <span className="action-icon-success"><Icon name="check" size={15} /></span>
    </span>
    <span className="action-label"><span aria-hidden="true" className="action-label-measure">{children}</span><span>{phase === 'success' && successLabel ? successLabel : children}</span></span>
  </button>
}
