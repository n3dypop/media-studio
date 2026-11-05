function Wait-OwnedProbe([Diagnostics.Process]$Child,[int]$TimeoutMs=30000,[scriptblock]$StopOwned={param($p) $p.Kill()}) {
    if($null -eq $Child -or $TimeoutMs -lt 1){throw 'Owned probe wait arguments are invalid.'}
    try { if($Child.WaitForExit($TimeoutMs)){return} } catch {
        # An observation failure is not proof that the process exited.
    }
    [Console]::Error.WriteLine('The owned maintenance probe timed out; both launch locks remain held until its exit is confirmed.')
    try{& $StopOwned $Child}catch{}
    # Never release the caller's handles while an owned child may still act.
    # A failed stop is not evidence of exit. External termination of this
    # process is outside this local guarantee and leaves the result unknown.
    while($true){
        try { if($Child.WaitForExit(1000)){break} } catch {
            # Keep the caller and its handles alive if exit cannot be observed.
            Start-Sleep -Seconds 1
        }
    }
    throw 'Maintenance probe timed out; its owned child has exited. No service was stopped.'
}
