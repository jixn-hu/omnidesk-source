import React from 'react'
import { MotionConfig } from 'motion/react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { initializeAppearance } from './store/appearance'
import './styles/design-system.css'
import './styles/app.css'
import './styles/motion.css'

initializeAppearance()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user"><App /></MotionConfig>
  </React.StrictMode>
)
