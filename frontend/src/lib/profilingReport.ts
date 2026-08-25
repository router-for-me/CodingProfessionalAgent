/**
 * Helper to format a performance report object into standard Markdown.
 */
export function formatProfilingReportMarkdown(report: any): string {
  if (!report) {
    return '# CPA Performance Profile Report\n\nNo report data available.\n'
  }
  if (typeof report === 'string') {
    return report
  }

  const summary = report.summary || {}
  const hotspots = Array.isArray(report.hotspots) ? report.hotspots : []
  const bottlenecks = Array.isArray(report.bottlenecks) ? report.bottlenecks : []
  const pluginMetrics = Array.isArray(report.pluginMetrics) ? report.pluginMetrics : []
  const aiSuggestions = Array.isArray(report.aiSuggestions) ? report.aiSuggestions : []

  const lines: string[] = []
  lines.push('# 🚀 Coding Professional Agent Performance Diagnostic Report')
  lines.push('')

  const durationSec =
    typeof summary.durationMs === 'number'
      ? (summary.durationMs / 1000).toFixed(2)
      : '0.00'
  const targetLabel =
    summary.target === 'all'
      ? 'Full-Stack (Main + Renderer + Plugins)'
      : summary.target === 'main'
        ? 'Main Process'
        : summary.target === 'renderer'
          ? 'Renderer Process'
          : summary.target || 'all'

  lines.push(`- **Sampling Duration**: ${durationSec}s | **Sampling Target**: ${targetLabel}`)
  lines.push(`- **Timestamp**: ${summary.timestamp || new Date().toISOString()}`)
  const cpuLoad =
    summary.cpuLoadPercent !== undefined
      ? Number(summary.cpuLoadPercent).toFixed(1)
      : '0.0'
  const loopDelay =
    summary.eventLoopDelayMs !== undefined
      ? `${Number(summary.eventLoopDelayMs).toFixed(1)}ms`
      : 'N/A'
  lines.push(`- **Active CPU Load**: ${cpuLoad}% | **Average Event Loop Delay**: ${loopDelay}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  lines.push('## 🔥 Top 10 CPU Hotspots')
  lines.push('')
  if (hotspots.length === 0) {
    lines.push('*(No significant hotspot functions captured)*')
    lines.push('')
  } else {
    lines.push('| Rank | Function | Location | Self Time | Total Time | Ratio | Module |')
    lines.push('|:---|:---|:---|:---|:---|:---|:---|')
    for (const h of hotspots) {
      const loc = h.url
        ? `${h.url}${h.lineNumber ? `:${h.lineNumber}` : ''}${h.columnNumber ? `:${h.columnNumber}` : ''}`
        : '[native code]'
      lines.push(
        `| ${h.rank || '-'} | \`${h.functionName || '(anonymous)'}\` | \`${loc}\` | ${Number(h.selfTimeMs || 0).toFixed(0)}ms | ${Number(h.totalTimeMs || 0).toFixed(0)}ms | ${Number(h.selfTimePercent || 0).toFixed(1)}% | ${h.module || 'App'} |`,
      )
    }
    lines.push('')
  }
  lines.push('---')
  lines.push('')

  lines.push(`## ⚠️ Detected Performance Bottlenecks (${bottlenecks.length})`)
  lines.push('')
  if (bottlenecks.length === 0) {
    lines.push('*(No obvious performance bottlenecks detected)*')
    lines.push('')
  } else {
    bottlenecks.forEach((b: any, index: number) => {
      const severityLabel =
        b.severity === 'HIGH' ? 'High' : b.severity === 'MEDIUM' ? 'Medium' : 'Low'
      lines.push(`${index + 1}. **[${b.type}] (${severityLabel})**: ${b.message}`)
      if (b.location) {
        lines.push(`   - **Location**: \`${b.location}\``)
      }
      if (b.selfTimeMs !== undefined) {
        const percentStr =
          b.selfTimePercent !== undefined
            ? ` (${Number(b.selfTimePercent).toFixed(1)}%)`
            : ''
        lines.push(`   - **Self Time**: ${Number(b.selfTimeMs).toFixed(0)}ms${percentStr}`)
      }
    })
    lines.push('')
  }
  lines.push('---')
  lines.push('')

  lines.push('## 🧩 Plugin Execution Time Statistics')
  lines.push('')
  if (pluginMetrics.length === 0) {
    lines.push('*(No plugin execution metrics)*')
    lines.push('')
  } else {
    lines.push('| Plugin ID | Hook Invocations | Total Time | Max Single Time | Status |')
    lines.push('|:---|:---|:---|:---|:---|')
    for (const p of pluginMetrics) {
      const status =
        p.maxDurationMs >= 10 || p.totalDurationMs >= 50 ? '⚠️ High' : 'Normal'
      lines.push(
        `| \`${p.pluginId}\` | ${p.callCount || 0} | ${Number(p.totalDurationMs || 0).toFixed(0)}ms | ${Number(p.maxDurationMs || 0).toFixed(1)}ms | ${status} |`,
      )
    }
    lines.push('')
  }
  lines.push('---')
  lines.push('')

  lines.push('## 💡 AI Automated Optimization Suggestions')
  lines.push('')
  if (aiSuggestions.length === 0) {
    lines.push('*(Current health is good, no optimization needed)*')
    lines.push('')
  } else {
    aiSuggestions.forEach((s: any, index: number) => {
      const target = s.targetFile
        ? ` (${s.targetFile}${s.targetLine ? `:${s.targetLine}` : ''})`
        : ''
      lines.push(`${index + 1}. **${s.category || 'OPTIMIZATION'}**${target}:`)
      lines.push(`   - ${s.action || ''}`)
    })
    lines.push('')
  }

  return lines.join('\n')
}
