function Get-ComfyTuning($Settings){
    $values=[ordered]@{memoryMode='auto';cacheMode='default';previewMethod='none';reserveGiB=$null}
    if($Settings.comfyTuning){
        foreach($key in $Settings.comfyTuning.PSObject.Properties.Name){
            if($key -cnotin @($values.Keys)){throw 'Unknown ComfyUI tuning setting.'}
            $values[$key]=$Settings.comfyTuning.$key
        }
    }
    if($values.memoryMode -cnotin @('auto','low','minimal') -or
       $values.cacheMode -cnotin @('default','none') -or
       $values.previewMethod -cnotin @('none','auto','latent2rgb')){
        throw 'Invalid ComfyUI tuning options.'
    }
    $extra=@()
    if($values.memoryMode -ceq 'low'){$extra+=@('--disable-dynamic-vram','--lowvram')}
    if($values.memoryMode -ceq 'minimal'){$extra+=@('--novram')}
    if($values.cacheMode -ceq 'none'){$extra+=@('--cache-none')}
    if($values.previewMethod -cne 'none'){$extra+=@('--preview-method',$values.previewMethod)}
    if($null -ne $values.reserveGiB){
        $reserve=$values.reserveGiB
        if(($reserve -isnot [double] -and $reserve -isnot [long] -and $reserve -isnot [int]) -or
            $reserve -lt 0.5 -or $reserve -gt 4 -or ($reserve*4)%1 -ne 0){throw 'Invalid ComfyUI VRAM reserve.'}
        $extra+=@('--reserve-vram',$reserve.ToString([Globalization.CultureInfo]::InvariantCulture))
    }
    return @{Values=$values;Arguments=$extra}
}
