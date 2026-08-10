#!/usr/bin/env pwsh
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'agent-worktree.ps1'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('agent-worktree-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $sandbox | Out-Null
try {
  function Run([string]$cwd, [string[]]$GitArgs) { $output = & git -C $cwd @GitArgs 2>&1; if ($LASTEXITCODE -ne 0) { throw "git failed: $($GitArgs -join ' ') output=$output" } }
  function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw "ASSERTION FAILED: $message" } }
  $repo = Join-Path $sandbox 'repo'; New-Item -ItemType Directory $repo | Out-Null
  Run $repo @('init', '-b', 'main'); Run $repo @('config', 'user.email', 'test@example.invalid'); Run $repo @('config', 'user.name', 'Test')
  Set-Content (Join-Path $repo 'README.md') 'seed'; Run $repo @('add', 'README.md'); Run $repo @('commit', '-m', 'seed')
  New-Item -ItemType Directory (Join-Path $repo '.worktrees') | Out-Null
  $wt = Join-Path $repo '.worktrees/task-1'; Run $repo @('worktree', 'add', '-b', 'task-1', $wt)
  $env:IMPLEMENTER_TASK_ID = 'task-1'
  & pwsh -NoProfile -File $scriptPath -Mode Initialize -WorktreePath $wt | Out-Null
  Assert ($LASTEXITCODE -eq 0) 'initialize succeeds for registered worktree'
  $env:AGENT_WORKTREE_ROLE = 'implementer'
  & pwsh -NoProfile -File $scriptPath -Mode Verify -WorktreePath $wt | Out-Null
  Assert ($LASTEXITCODE -eq 0) 'valid implementer worktree verifies'
  & pwsh -NoProfile -File $scriptPath -Mode CommitGuard -WorktreePath $repo 2>$null | Out-Null
  Assert ($LASTEXITCODE -ne 0) 'implementer context is blocked in main checkout'
  & pwsh -NoProfile -File $scriptPath -Mode CommitGuard -WorktreePath $wt | Out-Null
  Assert ($LASTEXITCODE -eq 0) 'implementer context is allowed in assigned worktree'
  $env:IMPLEMENTER_TASK_ID = 'wrong-task'
  & pwsh -NoProfile -File $scriptPath -Mode CommitGuard -WorktreePath $wt 2>$null | Out-Null
  Assert ($LASTEXITCODE -ne 0) 'mismatched task identity is blocked'
  $env:IMPLEMENTER_TASK_ID = 'task-1'
  Remove-Item Env:AGENT_WORKTREE_ROLE
  & pwsh -NoProfile -File $scriptPath -Mode CommitGuard -WorktreePath $repo | Out-Null
  Assert ($LASTEXITCODE -eq 0) 'ordinary human main checkout remains allowed'
  $baseline = (& git -C $repo rev-parse main).Trim()
  & pwsh -NoProfile -File $scriptPath -Mode AssertNoMainCommit -MainPath $repo -BaselineSha $baseline | Out-Null
  Assert ($LASTEXITCODE -eq 0) 'unchanged main passes dispatch invariant'
  Set-Content (Join-Path $repo 'main-change.txt') 'misrouted'; Run $repo @('add', '.'); Run $repo @('commit', '-m', 'misrouted')
  & pwsh -NoProfile -File $scriptPath -Mode AssertNoMainCommit -MainPath $repo -BaselineSha $baseline 2>$null | Out-Null
  Assert ($LASTEXITCODE -ne 0) 'advanced main is detected'
  Write-Output 'PASS: agent worktree guard tests'
} finally {
  if (Test-Path $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
}
