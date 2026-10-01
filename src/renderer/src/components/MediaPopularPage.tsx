import { useEffect, useState } from 'react'
import type { Workspace } from '../hooks/use-workspace'
import { MediaPopularView } from './MediaPopularView'
import { MediaLibrary } from './MediaLibrary'
import { useMediaPopular } from '../hooks/use-media-popular'
import '../styles/media-library.css'
import '../styles/media-popular.css'

export function MediaPopularPage({ workspace }: { workspace: Workspace }) {
  return (
    <MediaPopularContent
      key={JSON.stringify(workspace.settings.mediaServer)}
      workspace={workspace}
    />
  )
}

function MediaPopularContent({ workspace }: { workspace: Workspace }) {
  const [videoId, setVideoId] = useState<string | null>(null)
  const popular = useMediaPopular(workspace.loaded)
  const [visible, setVisible] = useState(workspace.settings.privacyCover.defaultEyeOpen)
  useEffect(
    () => setVisible(workspace.settings.privacyCover.defaultEyeOpen),
    [workspace.settings.privacyCover.defaultEyeOpen],
  )
  return (
    <>
      {videoId && (
        <MediaLibrary
          key={videoId}
          active
          workspace={workspace}
          entryId={videoId}
          coverVisible={visible}
          onExit={() => setVideoId(null)}
        />
      )}
      <section
        hidden={!!videoId}
        className="workspace-body panel media-library media-popular-page"
        aria-label="热门推荐"
      >
        <MediaPopularView
          active={!videoId}
          popular={popular}
          visible={visible}
          revision={JSON.stringify([
            workspace.settings.mediaServer,
            workspace.settings.privacyCover,
          ])}
          onOpenVideo={setVideoId}
          onToggleVisible={() => setVisible(!visible)}
        />
      </section>
    </>
  )
}
