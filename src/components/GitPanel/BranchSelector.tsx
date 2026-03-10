import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch as GitBranchIcon, Check, ChevronDown, Plus, Loader2, AlertTriangle, Archive } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'

type SwitchState = 
  | { type: 'idle' }
  | { type: 'confirming'; targetBranch: string; hasChanges: boolean }
  | { type: 'switching' }

export function BranchSelector() {
  const { t } = useTranslation('git')
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isSwitching, setIsSwitching] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [showNewBranch, setShowNewBranch] = useState(false)
  const [switchState, setSwitchState] = useState<SwitchState>({ type: 'idle' })
  const [error, setError] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const status = useGitStore((s) => s.status)
  const branches = useGitStore((s) => s.branches)
  const getBranches = useGitStore((s) => s.getBranches)
  const checkoutBranch = useGitStore((s) => s.checkoutBranch)
  const createBranch = useGitStore((s) => s.createBranch)
  const refreshStatus = useGitStore((s) => s.refreshStatus)
  const stashSave = useGitStore((s) => s.stashSave)
  const currentWorkspace = useWorkspaceStore((s) => s.getCurrentWorkspace())

  useEffect(() => {
    if (isOpen && currentWorkspace) {
      loadBranches()
    }
  }, [isOpen, currentWorkspace])

  useEffect(() => {
    if (showNewBranch && inputRef.current) {
      inputRef.current.focus()
    }
  }, [showNewBranch])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setShowNewBranch(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const loadBranches = useCallback(async () => {
    if (!currentWorkspace) return
    setIsLoading(true)
    try {
      await getBranches(currentWorkspace.path)
    } catch (err) {
      console.error('Failed to load branches:', err)
    } finally {
      setIsLoading(false)
    }
  }, [currentWorkspace, getBranches])

  const hasUncommittedChanges = useCallback(() => {
    if (!status) return false
    return status.staged.length > 0 || 
           status.unstaged.length > 0 || 
           status.untracked.length > 0
  }, [status])

  const doSwitchBranch = useCallback(async (branchName: string) => {
    if (!currentWorkspace) return

    setIsSwitching(true)
    setError(null)
    try {
      await checkoutBranch(currentWorkspace.path, branchName)
      await refreshStatus(currentWorkspace.path)
      setIsOpen(false)
      setSwitchState({ type: 'idle' })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      console.error('Failed to switch branch:', err)
    } finally {
      setIsSwitching(false)
    }
  }, [currentWorkspace, checkoutBranch, refreshStatus])

  const handleSwitchBranch = useCallback(async (branchName: string) => {
    if (!currentWorkspace || branchName === status?.branch) return

    if (hasUncommittedChanges()) {
      setSwitchState({ type: 'confirming', targetBranch: branchName, hasChanges: true })
    } else {
      await doSwitchBranch(branchName)
    }
  }, [currentWorkspace, status?.branch, hasUncommittedChanges, doSwitchBranch])

  const handleStashAndSwitch = useCallback(async () => {
    if (!currentWorkspace || switchState.type !== 'confirming') return

    const targetBranch = switchState.targetBranch
    setIsSwitching(true)
    try {
      await stashSave(currentWorkspace.path, `WIP: switching to ${targetBranch}`, true)
      await doSwitchBranch(targetBranch)
    } catch (err) {
      console.error('Failed to stash and switch:', err)
    } finally {
      setIsSwitching(false)
    }
  }, [currentWorkspace, switchState, stashSave, doSwitchBranch])

  const handleForceSwitch = useCallback(async () => {
    if (switchState.type !== 'confirming') return
    await doSwitchBranch(switchState.targetBranch)
  }, [switchState, doSwitchBranch])

  const handleCancelSwitch = useCallback(() => {
    setSwitchState({ type: 'idle' })
    setError(null)
  }, [])

  const handleCreateBranch = useCallback(async () => {
    if (!currentWorkspace || !newBranchName.trim()) return

    setIsSwitching(true)
    try {
      await createBranch(currentWorkspace.path, newBranchName.trim(), true)
      await refreshStatus(currentWorkspace.path)
      setNewBranchName('')
      setShowNewBranch(false)
      setIsOpen(false)
    } catch (err) {
      console.error('Failed to create branch:', err)
    } finally {
      setIsSwitching(false)
    }
  }, [currentWorkspace, newBranchName, createBranch, refreshStatus])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleCreateBranch()
    } else if (e.key === 'Escape') {
      setShowNewBranch(false)
      setNewBranchName('')
    }
  }

  const localBranches = branches.filter((b) => !b.isRemote)
  const remoteBranches = branches.filter((b) => b.isRemote)

  const getChangesCount = () => {
    if (!status) return 0
    return status.staged.length + status.unstaged.length + status.untracked.length
  }

  return (
    <>
      <div ref={containerRef} className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-1.5 px-2 py-1 text-sm text-text-primary hover:bg-background-hover rounded transition-colors"
        >
          <GitBranchIcon size={14} className="text-text-tertiary" />
          <span className="font-medium max-w-[120px] truncate">
            {status?.branch || 'HEAD'}
          </span>
          <ChevronDown size={12} className="text-text-tertiary" />
        </button>

        {isOpen && (
          <div className="absolute top-full left-0 mt-1 w-80 bg-background-surface border border-border rounded-lg shadow-lg z-50 flex flex-col max-h-[500px]">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between shrink-0">
              <span className="text-xs font-medium text-text-secondary">
                {t('branch.switch')}
              </span>
              <button
                onClick={() => setShowNewBranch(!showNewBranch)}
                className="p-1 text-text-tertiary hover:text-primary hover:bg-primary/10 rounded"
                title={t('branch.create')}
              >
                <Plus size={14} />
              </button>
            </div>

            {showNewBranch && (
              <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
                <input
                  ref={inputRef}
                  type="text"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={t('branch.newBranchPlaceholder')}
                  className="flex-1 px-2 py-1 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  onClick={handleCreateBranch}
                  disabled={!newBranchName.trim() || isSwitching}
                  className="p-1 text-primary hover:bg-primary/10 rounded disabled:opacity-50"
                >
                  {isSwitching ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                </button>
              </div>
            )}

            {error && (
              <div className="px-3 py-2 bg-danger/10 border-b border-danger/20 text-xs text-danger shrink-0">
                {error}
              </div>
            )}

            <div className="overflow-y-auto flex-1 min-h-0">
              {isLoading ? (
                <div className="px-3 py-4 text-center text-text-tertiary">
                  <Loader2 size={16} className="animate-spin mx-auto" />
                </div>
              ) : (
                <>
                  {localBranches.length > 0 && (
                    <>
                      <div className="px-3 py-1 text-xs text-text-tertiary bg-background sticky top-0">
                        本地分支 ({localBranches.length})
                      </div>
                      {localBranches.map((branch) => (
                        <button
                          key={branch.name}
                          onClick={() => handleSwitchBranch(branch.name)}
                          disabled={isSwitching || branch.isCurrent}
                          className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-background-hover ${
                            branch.isCurrent ? 'bg-primary/10 text-primary' : 'text-text-primary'
                          }`}
                        >
                          {branch.isCurrent && <Check size={12} />}
                          <span className={branch.isCurrent ? '' : 'ml-4'}>{branch.name}</span>
                        </button>
                      ))}
                    </>
                  )}

                  {remoteBranches.length > 0 && (
                    <>
                      <div className="px-3 py-1 text-xs text-text-tertiary bg-background sticky top-0">
                        远程分支 ({remoteBranches.length})
                      </div>
                      {remoteBranches.map((branch) => (
                        <button
                          key={branch.name}
                          onClick={() => handleSwitchBranch(branch.name)}
                          disabled={isSwitching}
                          className="w-full px-3 py-2 text-left text-sm text-text-secondary hover:bg-background-hover truncate"
                        >
                          {branch.name}
                        </button>
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {switchState.type === 'confirming' && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-lg">
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle size={20} className="text-warning shrink-0 mt-0.5" />
              <div>
                <h2 className="text-lg font-semibold text-text-primary mb-1">
                  {t('branch.uncommittedChanges')}
                </h2>
                <p className="text-sm text-text-secondary">
                  {t('branch.uncommittedChangesDesc', { count: getChangesCount() })}
                </p>
              </div>
            </div>

            <div className="space-y-2 mb-6">
              <button
                onClick={handleStashAndSwitch}
                disabled={isSwitching}
                className="w-full px-4 py-3 text-left text-sm bg-background-surface hover:bg-background-hover border border-border rounded-lg transition-colors flex items-center gap-3 disabled:opacity-50"
              >
                <Archive size={16} className="text-primary" />
                <div>
                  <div className="font-medium text-text-primary">{t('branch.stashAndSwitch')}</div>
                  <div className="text-xs text-text-tertiary">{t('branch.stashAndSwitchDesc')}</div>
                </div>
              </button>

              <button
                onClick={handleForceSwitch}
                disabled={isSwitching}
                className="w-full px-4 py-3 text-left text-sm bg-danger/10 hover:bg-danger/20 border border-danger/30 rounded-lg transition-colors flex items-center gap-3 disabled:opacity-50"
              >
                <AlertTriangle size={16} className="text-danger" />
                <div>
                  <div className="font-medium text-danger">{t('branch.forceSwitch')}</div>
                  <div className="text-xs text-danger/70">{t('branch.forceSwitchDesc')}</div>
                </div>
              </button>
            </div>

            <div className="flex justify-end">
              <button
                onClick={handleCancelSwitch}
                disabled={isSwitching}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
              >
                {t('cancel', { ns: 'common' })}
              </button>
            </div>

            {isSwitching && (
              <div className="absolute inset-0 bg-background-elevated/80 flex items-center justify-center rounded-xl">
                <Loader2 size={24} className="animate-spin text-primary" />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
