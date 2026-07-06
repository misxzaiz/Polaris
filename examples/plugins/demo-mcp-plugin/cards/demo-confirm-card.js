import React, { useState } from 'react'

function choiceList(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.choices)) {
    return [
      { id: 'approve', label: 'Approve' },
      { id: 'revise', label: 'Revise' },
      { id: 'decline', label: 'Decline' },
    ]
  }
  return data.choices
}

export default function DemoConfirmCard({ data, status, response, respond }) {
  const payload = data && typeof data === 'object' ? data : {}
  const choices = choiceList(payload)
  const [selected, setSelected] = useState(choices[0]?.id || 'approve')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const disabled = status !== 'pending' || !respond || submitting
  const finalResponse = response && typeof response === 'object' ? response : null

  async function submit() {
    if (!respond) return
    setSubmitting(true)
    try {
      await respond({
        selected,
        note,
        submittedAt: new Date().toISOString(),
      })
    } finally {
      setSubmitting(false)
    }
  }

  return React.createElement(
    'section',
    {
      className:
        'my-2 overflow-hidden rounded-lg border border-border bg-background-elevated shadow-sm',
    },
    React.createElement(
      'div',
      { className: 'border-b border-border bg-background-surface px-3 py-2' },
      React.createElement(
        'div',
        { className: 'text-sm font-semibold text-text-primary' },
        String(payload.title || 'Demo confirmation'),
      ),
      React.createElement(
        'div',
        { className: 'mt-1 text-xs text-text-secondary' },
        String(payload.detail || 'Choose a response below.'),
      ),
    ),
    React.createElement(
      'div',
      { className: 'space-y-3 px-3 py-3' },
      React.createElement(
        'div',
        { className: 'flex flex-wrap gap-2' },
        choices.map((choice) =>
          React.createElement(
            'button',
            {
              key: choice.id,
              type: 'button',
              disabled,
              onClick: () => setSelected(choice.id),
              className:
                selected === choice.id
                  ? 'rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary'
                  : 'rounded-md border border-border bg-background px-3 py-1.5 text-xs text-text-secondary hover:bg-background-hover',
            },
            choice.label || choice.id,
          ),
        ),
      ),
      React.createElement('textarea', {
        value: note,
        disabled,
        onChange: (event) => setNote(event.target.value),
        placeholder: 'Optional note',
        className:
          'min-h-20 w-full resize-y rounded-md border border-border bg-background px-2 py-2 text-sm text-text-primary outline-none focus:border-primary',
      }),
      finalResponse
        ? React.createElement(
            'pre',
            {
              className:
                'max-h-40 overflow-auto rounded-md bg-background-surface px-2 py-2 font-mono text-xs text-text-secondary',
            },
            JSON.stringify(finalResponse, null, 2),
          )
        : null,
      React.createElement(
        'div',
        { className: 'flex items-center justify-between gap-2' },
        React.createElement(
          'span',
          { className: 'text-xs text-text-tertiary' },
          status === 'pending' ? 'Waiting for your response' : `Status: ${status}`,
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            disabled,
            onClick: submit,
            className:
              'rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50',
          },
          submitting ? 'Submitting...' : 'Submit',
        ),
      ),
    ),
  )
}
