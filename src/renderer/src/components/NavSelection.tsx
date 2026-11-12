import { motion, useReducedMotion } from 'motion/react'

// Only the decoration moves; navigation targets and session panels stay in place.
export default function NavSelection({ active, group }: { active: boolean; group: string }) {
  const reduced = useReducedMotion()
  return active ? <motion.span aria-hidden="true" className="nav-selection" layoutId={group} initial={false}
    transition={{ duration: reduced ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }} /> : null
}
