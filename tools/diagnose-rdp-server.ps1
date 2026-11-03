[CmdletBinding()]
param()

function Invoke-ReadOnlyCheck {
    param([scriptblock]$Read)

    try {
        [pscustomobject]@{ ok = $true; data = (& $Read); error = $null }
    } catch {
        [pscustomobject]@{ ok = $false; data = $null; error = $_.Exception.Message }
    }
}

function Read-LocalWmiClass {
    param([string]$ClassName, [string]$Namespace = 'root/cimv2', [string]$Filter)

    $arguments = @{ Class = $ClassName; Namespace = $Namespace; ErrorAction = 'Stop' }
    if ($Filter) { $arguments.Filter = $Filter }
    if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {
        Get-CimInstance @arguments
    } else {
        Get-WmiObject @arguments -Authentication PacketPrivacy -Impersonation Impersonate
    }
}

function Read-RegistrySettings {
    param([string]$Path, [string[]]$Names)

    try {
        $settings = Get-ItemProperty -LiteralPath $Path -ErrorAction Stop
    } catch [System.Management.Automation.ItemNotFoundException] {
        return [pscustomobject]@{ state = 'notConfigured' }
    }

    $values = [ordered]@{ state = 'present' }
    foreach ($name in $Names) {
        $property = $settings.PSObject.Properties[$name]
        if ($null -ne $property) { $values[$name] = $property.Value }
        else { $values[$name] = $null }
    }
    [pscustomobject]$values
}

$report = [ordered]@{
    schemaVersion = 1
    readOnly = $true
    capturedAtUtc = [DateTime]::UtcNow.ToString('o')
    operatingSystem = Invoke-ReadOnlyCheck {
        Read-LocalWmiClass -ClassName Win32_OperatingSystem |
            Select-Object Caption, Version, BuildNumber, OSArchitecture
    }
    listener = Invoke-ReadOnlyCheck {
        $listener = Read-LocalWmiClass -ClassName Win32_TSGeneralSetting `
            -Namespace 'root/cimv2/terminalservices' -Filter "TerminalName='RDP-tcp'"
        if ($null -eq $listener) { throw 'The RDP-tcp listener was not found.' }
        $listener | Select-Object TerminalName, SecurityLayer, UserAuthenticationRequired, `
            MinEncryptionLevel, PolicySourceSecurityLayer, PolicySourceUserAuthenticationRequired, `
            SSLCertificateSHA1Hash, SSLCertificateSHA1HashType
    }
    listenerRegistry = Invoke-ReadOnlyCheck {
        Read-RegistrySettings -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' `
            -Names SecurityLayer, UserAuthentication, MinEncryptionLevel, PortNumber
    }
    policyRegistry = Invoke-ReadOnlyCheck {
        Read-RegistrySettings -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services' `
            -Names SecurityLayer, UserAuthentication, MinEncryptionLevel
    }
    tls12ServerRegistry = Invoke-ReadOnlyCheck {
        Read-RegistrySettings -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Server' `
            -Names Enabled, DisabledByDefault
    }
    remoteDesktopService = Invoke-ReadOnlyCheck {
        $service = Get-Service -Name TermService -ErrorAction Stop
        [pscustomobject]@{ status = $service.Status.ToString() }
    }
    notes = @(
        'Run this script on the target server, not the OmniDesk workstation.'
        'A missing registry key or value means not explicitly configured; it does not mean TLS is disabled.'
        'Raw WMI values and registry values are reported separately. Confirm the negotiated protocol before changing settings.'
        'This report does not prove TLS compatibility, certificate private-key permissions, or successful login.'
        'No settings, certificates, passwords, firewall rules, or services are changed.'
    )
}

$report | ConvertTo-Json -Depth 6
