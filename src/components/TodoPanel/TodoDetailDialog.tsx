/**
 * TodoDetailDialog - 待办详情/编辑弹窗
 *
 * 使用 TodoForm 组件,移除快速操作
 * 点击外部不关闭，需要点击关闭按钮
 */

import { X, Trash2 } from 'lucide-react'
import { TodoForm } from './TodoForm'
import { simpleTodoService } from '@/services/simpleTodoService'
import type { TodoItem } from '@/types'

interface TodoDetailDialogProps {
  todo: TodoItem
  open: boolean
  onClose: () => void
  onUpdate?: () => void
  onDelete?: () => void
}

export function TodoDetailDialog({ todo, open, onClose, onUpdate, onDelete }: TodoDetailDialogProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 bg-overlay flex items-center justify-center z-50">
      <div
        className="bg-background-elevated rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：标题 + 关闭按钮 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-base font-medium text-text-primary">编辑待办</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-background-hover text-text-secondary hover:text-text-primary transition-all"
            title="关闭"
          >
            <X size={18} />
          </button>
        </div>

        {/* 表单内容 */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <TodoForm
            todo={todo}
            mode="edit"
            onSubmit={async (data) => {
              await simpleTodoService.updateTodo(todo.id, data)
              onUpdate?.()
              onClose()
            }}
            onCancel={onClose}
          />
        </div>

        {/* 底部操作栏 */}
        {onDelete && (
          <div className="px-4 py-3 border-t border-border">
            <button
              onClick={() => {
                if (confirm(`确定要删除待办 "${todo.content}" 吗？此操作不可恢复。`)) {
                  onDelete()
                  onClose()
                }
              }}
              className="w-full px-4 py-2 text-sm bg-status-danger text-on-primary rounded-lg hover:bg-status-danger/80 transition-all flex items-center justify-center gap-2"
            >
              <Trash2 size={16} />
              删除待办
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
