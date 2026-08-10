#!/usr/bin/env pwsh
<#$
.SYNOPSIS
  Enforces the implementer worktree commit boundary.

  Implementer context is enabled by the worktree-scoped Git setting
  agent.role=implementer or AGENT_WORKTREE_ROLE=implementer. Human commits in
  an ordinary main checkout remain unaffected.
#>
[CmdletBinding()]
param(
  [ValidateSet('Initialize', 'Verify', 'CommitGuard', 'Snapshot', 'AssertNoMainCommit')]
  [string]$Mode = 'Verify',
  [string]$WorktreePath,
  [string]$BaselineSha,
  [string]$MainPath,
  [string]$MainBranch = 'main'
)

$ErrorActionPreference = 'Stop'

function Invoke-Git([string]$Path, [string[]]$GitArgs) {
  $output = & git -C $Path @GitArgs 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed in $Path`: $output" }
  return ($output -join "`n").Trim()
}

function Resolve-NormalizedPath([string]$Path) {
  if (-not $Path) { throw 'Path is required' }
  return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path).TrimEnd('\', '/')
}

function Get-RepoRoot([string]$Path) {
  return Resolve-NormalizedPath (Invoke-Git $Path @('rev-parse', '--show-toplevel'))
}

function Get-WorktreeRecords([string]$RepoRoot) {
  $lines = (Invoke-Git $RepoRoot @('worktree', 'list', '--porcelain')) -split "`n"
  $records = @(); $current = $null
  foreach ($line in $lines) {
    if ($line -like 'worktree *') {
      if ($current) { $records += [PSCustomObject]$current }
      $current = @{ Path = Resolve-NormalizedPath ($line.Substring(9).Trim()) }
    } elseif ($current -and $line -like 'branch *') {
      $current.Branch = $line.Substring(7).Trim()
    }
  }
  if ($current) { $records += [PSCustomObject]$current }
  return $records
}

function Test-IsImplementer([string]$RepoRoot) {
  $role = (& git -C $RepoRoot config --worktree --get agent.role 2>$null)
  return (($role -eq 'implementer') -or ($env:AGENT_WORKTREE_ROLE -eq 'implementer'))
}

function Assert-ImplementerWorktree([string]$RepoRoot) {
  $records = @(Get-WorktreeRecords $RepoRoot)
  $current = Resolve-NormalizedPath $RepoRoot
  $repoName = Split-Path $RepoRoot -Leaf
  $mainWorktree = $records | Select-Object -First 1
  $expectedPrefix = ([IO.Path]::GetFullPath((Join-Path $mainWorktree.Path '.worktrees'))).TrimEnd('\', '/')
  $registered = $records | Where-Object { $_.Path -ieq $current }
  $underWorktrees = $current.StartsWith($expectedPrefix + '\', [StringComparison]::OrdinalIgnoreCase)
  if (-not $registered -or -not $underWorktrees) {
    throw "IMPLEMENTER COMMIT BLOCKED: checkout '$current' is not a registered worktree under '$expectedPrefix' (repo '$repoName')."
  }
  if ($env:IMPLEMENTER_TASK_ID) {
    $configuredTask = (& git -C $RepoRoot config --worktree --get agent.taskId 2>$null)
    if ($configuredTask -ne $env:IMPLEMENTER_TASK_ID) { throw "IMPLEMENTER COMMIT BLOCKED: task identity '$env:IMPLEMENTER_TASK_ID' does not match worktree task '$configuredTask'." }
  }
  return $true
}

function Initialize-Worktree([string]$Path) {
  $root = Get-RepoRoot $Path
  $normalized = Resolve-NormalizedPath $root
  Invoke-Git $normalized @('config', 'extensions.worktreeConfig', 'true') | Out-Null
  Invoke-Git $normalized @('config', '--worktree', 'agent.role', 'implementer') | Out-Null
  if ($env:IMPLEMENTER_TASK_ID) {
    Invoke-Git $normalized @('config', '--worktree', 'agent.taskId', $env:IMPLEMENTER_TASK_ID) | Out-Null
  }
  Invoke-Git $normalized @('config', '--worktree', 'core.hooksPath', '.githooks') | Out-Null
  Assert-ImplementerWorktree $normalized | Out-Null
  Write-Output "initialized implementer worktree: $normalized"
}

$repoRoot = if ($WorktreePath) { Get-RepoRoot $WorktreePath } else { Get-RepoRoot (Get-Location).Path }

switch ($Mode) {
  'Initialize' { Initialize-Worktree ($WorktreePath ?? $repoRoot); exit 0 }
  'Verify' {
    if (Test-IsImplementer $repoRoot) { Assert-ImplementerWorktree $repoRoot | Out-Null }
    Write-Output "verified checkout: $repoRoot"
    exit 0
  }
  'CommitGuard' {
    if (Test-IsImplementer $repoRoot) { Assert-ImplementerWorktree $repoRoot | Out-Null }
    exit 0
  }
  'Snapshot' {
    $head = Invoke-Git $repoRoot @('rev-parse', 'HEAD')
    [PSCustomObject]@{ repoRoot = $repoRoot; head = $head; branch = Invoke-Git $repoRoot @('branch', '--show-current') } | ConvertTo-Json -Compress
    exit 0
  }
  'AssertNoMainCommit' {
    if (-not $MainPath -or -not $BaselineSha) { throw 'MainPath and BaselineSha are required' }
    $mainRoot = Get-RepoRoot $MainPath
    $current = Invoke-Git $mainRoot @('rev-parse', $MainBranch)
    if ($current -ne $BaselineSha) { throw "DISPATCH BLOCKED: main branch '$MainBranch' advanced from $BaselineSha to $current." }
    Write-Output "main unchanged: $current"
    exit 0
  }
}
