import { useCallback, useEffect, useState } from 'react'
import type { BootstrapInfo } from '../shared/ipc'
import type { IndexStatus, JarvisSettings } from '../shared/types'
import { HomePage } from './pages/HomePage'
import { FilesPage } from './pages/FilesPage'
import { SettingsPage } from './pages/SettingsPage'
import { ComingLater } from './components/ComingLater'

function folderSummary(indexing: boolean, count: number): string {
  if (indexing) return 'Indexing…'
  if (count === 0) return 'No folders authorised'
  return `${count} folder${count === 1 ? '' : 's'} authorised`
}

type Route = 'home' | 'tasks' | 'businesses' | 'files' | 'research' | 'automations' | 'settings'

interface NavEntry {
  id: Route
  label: string
  /** Set for sections that are not part of V0.1. */
  later?: string
}

const NAV: NavEntry[] = [
  { id: 'home', label: 'Home' },
  { id: 'tasks', label: 'Tasks', later: 'V0.4' },
  { id: 'businesses', label: 'Businesses', later: 'V0.3' },
  { id: 'files', label: 'Files' },
  { id: 'research', label: 'Research', later: 'V0.5' },
  { id: 'automations', label: 'Automations', later: 'V0.5' },
  { id: 'settings', label: 'Settings' }
]

export function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>('home')
  const [bootstrap, setBootstrap] = useState<BootstrapInfo | null>(null)
  const [settings, setSettings] = useState<JarvisSettings | null>(null)
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null)

  const refreshSettings = useCallback(async () => {
    setSettings(await window.jarvis.settings.get())
  }, [])

  useEffect(() => {
    void (async () => {
      setBootstrap(await window.jarvis.getBootstrap())
      await refreshSettings()
      setIndexStatus(await window.jarvis.index.status())
    })()
    return window.jarvis.index.onStatusChange(setIndexStatus)
  }, [refreshSettings])

  const indexing = indexStatus ? indexStatus.phase !== 'idle' : false

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand__name">JARVIS</div>
          <div className="brand__tagline">Your Life. Organised. Ahead.</div>
        </div>

        <nav className="nav">
          {NAV.map((entry) => (
            <button
              key={entry.id}
              className={`nav__item${route === entry.id ? ' nav__item--active' : ''}`}
              onClick={() => setRoute(entry.id)}
            >
              <span>{entry.label}</span>
              {entry.later ? <span className="nav__later">{entry.later}</span> : null}
            </button>
          ))}
        </nav>

        <div className="sidebar__footer">
          <div className="status-line">
            <span className={`dot${indexing ? ' dot--active' : ' dot--ok'}`} />
            <span className="truncate">{folderSummary(indexing, settings?.folders.length ?? 0)}</span>
          </div>
          <span>Jarvis {bootstrap?.appVersion ?? ''} · Local Intelligence</span>
        </div>
      </aside>

      <main className="main">
        <div className="main__inner">
          {route === 'home' && settings ? <HomePage settings={settings} /> : null}

          {route === 'files' ? <FilesPage settings={settings} /> : null}

          {route === 'settings' && bootstrap && settings ? (
            <SettingsPage
              bootstrap={bootstrap}
              settings={settings}
              indexStatus={indexStatus}
              onSettingsChanged={refreshSettings}
            />
          ) : null}

          {route === 'tasks' ? (
            <ComingLater
              title="Tasks"
              version="V0.4"
              description="Task capture, carrying unfinished work forward day to day, and pulling handwritten tasks off your reMarkable."
              plans={[
                'Tasks written on your reMarkable are read in and turned into tracked items.',
                'Anything not finished today is carried forward automatically rather than lost.',
                'Meetings are identified from your notes and linked to the tasks that came out of them.'
              ]}
            />
          ) : null}

          {route === 'businesses' ? (
            <ComingLater
              title="Businesses"
              version="V0.3"
              description="Separate context for each of your businesses, so a question about one is never answered with documents from another."
              plans={[
                'GTA, Titan, Pathlyn, your NDIS businesses and personal information each get their own context.',
                'Folders are tagged to a business when you authorise them, and answers stay inside that boundary.',
                'The groundwork is already in place: authorised folders carry a context field today, unused until V0.3.'
              ]}
            />
          ) : null}

          {route === 'research' ? (
            <ComingLater
              title="Research"
              version="V0.5"
              description="Letting Jarvis look things up beyond your own files, with the same rules about what it may and may not do."
              plans={[
                'Browser and application automation, gated behind explicit approval for anything consequential.',
                'Findings brought back with sources, the same way document answers are cited today.'
              ]}
            />
          ) : null}

          {route === 'automations' ? (
            <ComingLater
              title="Automations"
              version="V0.5"
              description="Standing instructions Jarvis carries out on your behalf, with approval controls for anything that changes the outside world."
              plans={[
                'Actions that only read information can run on their own.',
                'Anything that sends, files, changes or spends requires your explicit approval first.',
                'Every action is written to the local activity log, which already records what Jarvis does today.'
              ]}
            />
          ) : null}
        </div>
      </main>
    </div>
  )
}
