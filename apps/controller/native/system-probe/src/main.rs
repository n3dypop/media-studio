use serde_json::{json, Value};

type Result<T> = std::result::Result<T, &'static str>;

const FILETIME_DOTNET_OFFSET: u64 = 504_911_232_000_000_000;
const DOTNET_MAX_TICKS: u64 = 3_155_378_975_999_999_999;

fn dotnet_ticks(filetime: u64) -> Result<String> {
    filetime
        .checked_add(FILETIME_DOTNET_OFFSET)
        .filter(|x| *x <= DOTNET_MAX_TICKS)
        .map(|x| x.to_string())
        .ok_or("invalid process creation time")
}

#[derive(Debug, PartialEq)]
enum Command {
    Resources,
    Processes(Vec<u32>),
    Epoch(u32, u16),
}
#[derive(Debug, PartialEq)]
struct Arguments {
    command: Command,
    metrics: bool,
}

fn decimal(text: &str) -> Result<u32> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err("invalid numeric argument");
    }
    text.parse::<u32>()
        .ok()
        .filter(|n| *n != 0)
        .ok_or("invalid numeric argument")
}
fn arguments(mut args: Vec<String>) -> Result<Arguments> {
    let metrics = args.last().map(|x| x == "--metrics").unwrap_or(false);
    if metrics {
        args.pop();
    }
    let command = match args.as_slice() {
        [name] if name == "resources" => Command::Resources,
        [name, pids] if name == "processes" => {
            let list = pids.split(',').map(decimal).collect::<Result<Vec<_>>>()?;
            if list.len() > 64 {
                return Err("too many process IDs");
            }
            let mut unique = list.clone();
            unique.sort_unstable();
            unique.dedup();
            if unique.len() != list.len() {
                return Err("duplicate process ID");
            }
            Command::Processes(list)
        }
        [name, pid, port] if name == "epoch" => {
            let port = decimal(port)?;
            if port > u16::MAX as u32 {
                return Err("invalid port");
            }
            Command::Epoch(decimal(pid)?, port as u16)
        }
        _ => return Err("unsupported command or arguments"),
    };
    Ok(Arguments { command, metrics })
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{
        mem::{size_of, zeroed},
        ptr::null_mut,
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_INSUFFICIENT_BUFFER, ERROR_NO_MORE_FILES, FILETIME,
            HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT,
        },
        NetworkManagement::IpHelper::{
            GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
        },
        Networking::WinSock::AF_INET,
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            ProcessStatus::{
                GetPerformanceInfo, GetProcessMemoryInfo, PERFORMANCE_INFORMATION,
                PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX, PROCESS_MEMORY_COUNTERS_EX2,
            },
            SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX},
            Threading::{
                GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_VM_READ,
            },
        },
    };

    pub struct Process {
        handle: HANDLE,
        pid: u32,
    }
    impl Drop for Process {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
    #[derive(Clone, PartialEq)]
    struct Identity {
        pid: u32,
        ticks: String,
        executable: String,
    }
    impl Identity {
        fn json(&self) -> Value {
            json!({"pid":self.pid,"startTimeUtcTicks":self.ticks,"executable":self.executable})
        }
    }
    fn ticks(value: FILETIME) -> u64 {
        ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
    }

    impl Process {
        pub fn open(pid: u32, memory: bool) -> Result<Self> {
            // WaitForSingleObject needs SYNCHRONIZE as well as query access.
            let access = PROCESS_QUERY_LIMITED_INFORMATION
                | PROCESS_SYNCHRONIZE
                | if memory { PROCESS_VM_READ } else { 0 };
            let handle = unsafe { OpenProcess(access, 0, pid) };
            if handle.is_null() {
                return Err("process handle unavailable");
            }
            let result = Self { handle, pid };
            result.alive()?;
            Ok(result)
        }
        fn alive(&self) -> Result<()> {
            if unsafe { WaitForSingleObject(self.handle, 0) } != WAIT_TIMEOUT {
                return Err("process exited or liveness unavailable");
            }
            Ok(())
        }
        fn times(&self) -> Result<(u64, u64, u64)> {
            let (mut created, mut exited, mut kernel, mut user): (
                FILETIME,
                FILETIME,
                FILETIME,
                FILETIME,
            ) = unsafe { zeroed() };
            if unsafe {
                GetProcessTimes(
                    self.handle,
                    &mut created,
                    &mut exited,
                    &mut kernel,
                    &mut user,
                )
            } == 0
            {
                return Err("process times unavailable");
            }
            Ok((ticks(created), ticks(kernel), ticks(user)))
        }
        fn identity(&self) -> Result<Identity> {
            self.alive()?;
            let mut buffer = vec![0u16; 32768];
            let mut length = buffer.len() as u32;
            if unsafe {
                QueryFullProcessImageNameW(self.handle, 0, buffer.as_mut_ptr(), &mut length)
            } == 0
                || length == 0
                || length as usize >= buffer.len()
            {
                return Err("process image unavailable");
            }
            let executable = String::from_utf16(&buffer[..length as usize])
                .map_err(|_| "invalid process image encoding")?;
            let result = Identity {
                pid: self.pid,
                ticks: dotnet_ticks(self.times()?.0)?,
                executable,
            };
            self.alive()?;
            Ok(result)
        }
        fn memory(&self) -> Result<Memory> {
            let mut extended: PROCESS_MEMORY_COUNTERS_EX2 = unsafe { zeroed() };
            extended.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32;
            let resident = if unsafe {
                GetProcessMemoryInfo(
                    self.handle,
                    &mut extended as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
                    extended.cb,
                )
            } != 0
            {
                Some(extended.PrivateWorkingSetSize as u64)
            } else {
                let mut base: PROCESS_MEMORY_COUNTERS_EX = unsafe { zeroed() };
                base.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
                if unsafe {
                    GetProcessMemoryInfo(
                        self.handle,
                        &mut base as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
                        base.cb,
                    )
                } == 0
                {
                    return Err("process memory unavailable");
                }
                extended.WorkingSetSize = base.WorkingSetSize;
                extended.PeakWorkingSetSize = base.PeakWorkingSetSize;
                extended.PrivateUsage = base.PrivateUsage;
                None
            };
            self.alive()?;
            Ok(Memory {
                working: extended.WorkingSetSize as u64,
                peak: extended.PeakWorkingSetSize as u64,
                private: extended.PrivateUsage as u64,
                resident,
            })
        }
    }
    struct Memory {
        working: u64,
        peak: u64,
        private: u64,
        resident: Option<u64>,
    }
    pub fn processes(pids: &[u32]) -> Result<Value> {
        let held = pids
            .iter()
            .map(|pid| Process::open(*pid, true))
            .collect::<Result<Vec<_>>>()?;
        let before = held
            .iter()
            .map(Process::identity)
            .collect::<Result<Vec<_>>>()?;
        let memories = held
            .iter()
            .map(Process::memory)
            .collect::<Result<Vec<_>>>()?;
        let after = held
            .iter()
            .map(Process::identity)
            .collect::<Result<Vec<_>>>()?;
        if before != after {
            return Err("process identity changed during memory sample");
        }
        Ok(Value::Array(before.iter().zip(memories.iter()).map(|(identity,memory)| json!({
            "pid":identity.pid,"startTimeUtcTicks":identity.ticks,"executable":identity.executable,
            "workingSetBytes":memory.working,"privateBytes":memory.private,"residentPrivateBytes":memory.resident
        })).collect()))
    }
    pub fn resources() -> Result<Value> {
        let mut physical: MEMORYSTATUSEX = unsafe { zeroed() };
        physical.dwLength = size_of::<MEMORYSTATUSEX>() as u32;
        if unsafe { GlobalMemoryStatusEx(&mut physical) } == 0 {
            return Err("physical memory unavailable");
        }
        let mut performance: PERFORMANCE_INFORMATION = unsafe { zeroed() };
        performance.cb = size_of::<PERFORMANCE_INFORMATION>() as u32;
        if unsafe { GetPerformanceInfo(&mut performance, performance.cb) } == 0 {
            return Err("commit memory unavailable");
        }
        let used = (performance.CommitTotal as u64)
            .checked_mul(performance.PageSize as u64)
            .ok_or("commit value overflow")?;
        let limit = (performance.CommitLimit as u64)
            .checked_mul(performance.PageSize as u64)
            .ok_or("commit value overflow")?;
        if physical.ullAvailPhys > physical.ullTotalPhys
            || used > limit
            || performance.PageSize == 0
        {
            return Err("invalid memory observation");
        }
        Ok(
            json!({"ramAvailableBytes":physical.ullAvailPhys,"ramTotalBytes":physical.ullTotalPhys,"commitUsedBytes":used,"commitLimitBytes":limit,"commitAvailableBytes":limit-used}),
        )
    }
    fn listener(port: u16) -> Result<u32> {
        let mut bytes = 0u32;
        let first = unsafe {
            GetExtendedTcpTable(
                null_mut(),
                &mut bytes,
                0,
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if first != ERROR_INSUFFICIENT_BUFFER && first != 0 {
            return Err("TCP listener size unavailable");
        }
        for _ in 0..3 {
            if !(4..=16 * 1024 * 1024).contains(&bytes) {
                return Err("invalid TCP table size");
            }
            // The table contains u32 fields. A u64 allocation provides alignment.
            let mut words = vec![0u64; (bytes as usize).div_ceil(8)];
            let capacity = (words.len() * 8) as u32;
            bytes = capacity;
            let status = unsafe {
                GetExtendedTcpTable(
                    words.as_mut_ptr().cast(),
                    &mut bytes,
                    0,
                    AF_INET as u32,
                    TCP_TABLE_OWNER_PID_LISTENER,
                    0,
                )
            };
            if status == ERROR_INSUFFICIENT_BUFFER {
                continue;
            }
            if status != 0 || bytes > capacity || bytes < 4 {
                return Err("TCP listener table unavailable");
            }
            let pointer = words.as_ptr().cast::<u8>();
            let count = unsafe { *(pointer.cast::<u32>()) } as usize;
            let required = count
                .checked_mul(size_of::<MIB_TCPROW_OWNER_PID>())
                .and_then(|n| n.checked_add(4))
                .ok_or("TCP count overflow")?;
            if required > bytes as usize {
                return Err("invalid TCP listener table");
            }
            let rows = unsafe {
                std::slice::from_raw_parts(pointer.add(4).cast::<MIB_TCPROW_OWNER_PID>(), count)
            };
            let matches = rows
                .iter()
                .filter(|row| {
                    row.dwLocalAddr.to_ne_bytes() == [127, 0, 0, 1]
                        && u16::from_be(row.dwLocalPort as u16) == port
                })
                .collect::<Vec<_>>();
            if matches.len() != 1 || matches[0].dwOwningPid == 0 {
                return Err("expected exactly one loopback listener");
            }
            return Ok(matches[0].dwOwningPid);
        }
        Err("TCP listener table changed repeatedly")
    }
    fn parent(pid: u32) -> Result<u32> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("process snapshot unavailable");
        }
        struct Snapshot(HANDLE);
        impl Drop for Snapshot {
            fn drop(&mut self) {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
        let _held = Snapshot(snapshot);
        let mut row: PROCESSENTRY32W = unsafe { zeroed() };
        row.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        if unsafe { Process32FirstW(snapshot, &mut row) } == 0 {
            return Err("process ancestry unavailable");
        }
        loop {
            if row.th32ProcessID == pid {
                return Ok(row.th32ParentProcessID);
            }
            if unsafe { Process32NextW(snapshot, &mut row) } == 0 {
                if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
                    return Err("process ancestry query failed");
                }
                break;
            }
        }
        Err("listener process absent from snapshot")
    }
    pub fn epoch(pid: u32, port: u16) -> Result<Value> {
        let managed = Process::open(pid, false)?;
        let managed_before = managed.identity()?;
        let listener_pid = listener(port)?;
        let held_listener = Process::open(listener_pid, false)?;
        let listener_before = held_listener.identity()?;
        let parent_pid = parent(listener_pid)?;
        if listener(port)? != listener_pid || parent(listener_pid)? != parent_pid {
            return Err("listener owner or ancestry changed");
        }
        if managed.identity()? != managed_before || held_listener.identity()? != listener_before {
            return Err("process identity changed during epoch sample");
        }
        Ok(
            json!({"managed":managed_before.json(),"listener":{"pid":listener_before.pid,"startTimeUtcTicks":listener_before.ticks,"executable":listener_before.executable,"parentPid":parent_pid}}),
        )
    }
    pub fn metrics() -> Result<Value> {
        let process = Process::open(std::process::id(), true)?;
        let memory = process.memory()?;
        let (_, kernel, user) = process.times()?;
        let cpu = kernel.checked_add(user).ok_or("CPU time overflow")? as f64 / 10_000_000.0;
        Ok(
            json!({"peakWorkingSetBytes":memory.peak,"privateBytes":memory.private,"cpuSeconds":cpu}),
        )
    }
}

fn run(args: Arguments) -> Result<Value> {
    #[cfg(not(windows))]
    {
        let _ = args;
        Err("Windows is required")
    }
    #[cfg(windows)]
    {
        let data = match args.command {
            Command::Resources => native::resources()?,
            Command::Processes(pids) => native::processes(&pids)?,
            Command::Epoch(pid, port) => native::epoch(pid, port)?,
        };
        let mut value = json!({"schemaVersion":1,"data":data});
        if args.metrics {
            value["metrics"] = native::metrics()?;
        }
        Ok(value)
    }
}
fn main() {
    let result = arguments(std::env::args().skip(1).collect()).and_then(run);
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("Native resource probe failed: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Result<Arguments> {
        arguments(values.iter().map(|x| x.to_string()).collect())
    }
    #[test]
    fn filetime_epoch_conversion() {
        assert_eq!(dotnet_ticks(0).unwrap(), "504911232000000000");
        assert_eq!(
            dotnet_ticks(116_444_736_000_000_000).unwrap(),
            "621355968000000000"
        );
        assert!(dotnet_ticks(u64::MAX).is_err());
    }
    #[test]
    fn valid_cli_contract() {
        assert_eq!(
            args(&["resources", "--metrics"]).unwrap(),
            Arguments {
                command: Command::Resources,
                metrics: true
            }
        );
        assert_eq!(
            args(&["processes", "1,2"]).unwrap().command,
            Command::Processes(vec![1, 2])
        );
        assert_eq!(
            args(&["epoch", "1", "65535"]).unwrap().command,
            Command::Epoch(1, 65535)
        );
    }
    #[test]
    fn invalid_cli_is_bounded() {
        for values in [
            vec![],
            vec!["resources", "extra"],
            vec!["resources", "--metrics", "--metrics"],
            vec!["processes", ""],
            vec!["processes", "0"],
            vec!["processes", "1,1"],
            vec!["processes", "+1"],
            vec!["epoch", "1", "65536"],
            vec!["epoch", "-1", "80"],
            vec!["children", "1"],
        ] {
            assert!(args(&values).is_err(), "{values:?}");
        }
        let pids = (1..=65)
            .map(|x| x.to_string())
            .collect::<Vec<_>>()
            .join(",");
        assert!(args(&["processes", &pids]).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn native_self_process_has_precise_identity() {
        let value = native::processes(&[std::process::id()]).unwrap();
        let row = &value[0];
        assert_eq!(row["pid"], std::process::id());
        assert!(
            row["startTimeUtcTicks"]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
                > FILETIME_DOTNET_OFFSET
        );
        assert!(row["workingSetBytes"].as_u64().unwrap() > 0);
        assert!(row["executable"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .ends_with(".exe"));
    }
    #[cfg(windows)]
    #[test]
    fn native_memory_invariants() {
        let value = native::resources().unwrap();
        assert!(
            value["ramAvailableBytes"].as_u64().unwrap()
                <= value["ramTotalBytes"].as_u64().unwrap()
        );
        assert_eq!(
            value["commitAvailableBytes"].as_u64().unwrap()
                + value["commitUsedBytes"].as_u64().unwrap(),
            value["commitLimitBytes"].as_u64().unwrap()
        );
    }
    #[cfg(windows)]
    #[test]
    fn own_loopback_listener_is_observed_without_http() {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let value =
            native::epoch(std::process::id(), listener.local_addr().unwrap().port()).unwrap();
        assert_eq!(value["managed"]["pid"], std::process::id());
        assert_eq!(value["listener"]["pid"], std::process::id());
    }
    #[cfg(windows)]
    #[test]
    fn child_loopback_listener_has_parent_identity() {
        use std::io::{BufRead, Read, Write};
        use std::process::{Command as ChildCommand, Stdio};
        let mut child = ChildCommand::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::owned_listener_fixture", "--nocapture"])
            .env("NATIVE_PROBE_CHILD_FIXTURE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut reader = std::io::BufReader::new(stdout);
        let mut port = None;
        for line in reader.by_ref().lines() {
            let line = line.unwrap();
            if let Some(value) = line.strip_prefix("PROBE_TEST_PORT=") {
                port = Some(value.parse::<u16>().unwrap());
                break;
            }
        }
        let value = native::epoch(std::process::id(), port.expect("child did not bind")).unwrap();
        assert_eq!(value["listener"]["pid"], child.id());
        assert_eq!(value["listener"]["parentPid"], std::process::id());
        assert!(
            value["listener"]["startTimeUtcTicks"]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
                >= value["managed"]["startTimeUtcTicks"]
                    .as_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap()
        );
        child.stdin.take().unwrap().write_all(b"done\n").unwrap();
        let mut tail = String::new();
        reader.read_to_string(&mut tail).unwrap();
        assert!(child.wait().unwrap().success(), "{tail}");
    }
    #[cfg(windows)]
    #[test]
    fn owned_listener_fixture() {
        if std::env::var_os("NATIVE_PROBE_CHILD_FIXTURE").is_none() {
            return;
        }
        use std::io::Write;
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        println!(
            "\nPROBE_TEST_PORT={}",
            listener.local_addr().unwrap().port()
        );
        std::io::stdout().flush().unwrap();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
        drop(listener);
    }
}
