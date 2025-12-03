#!/usr/bin/env node

const https = require('https');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 获取Mullvad服务器列表（使用CLI方式）
async function getMullvadServers() {
    return new Promise((resolve, reject) => {
        try {
            const output = execSync('mullvad relay list', { encoding: 'utf8', timeout: 30000 });
            const servers = parseMullvadRelayList(output);
            resolve(servers);
        } catch (error) {
            reject(error);
        }
    });
}

// 解析Mullvad relay list输出
function parseMullvadRelayList(output) {
    const servers = [];
    const lines = output.split('\n');
    let currentCountry = '';
    let currentCity = '';

    for (const line of lines) {
        // 国家行：Country (code)
        const countryMatch = line.match(/^([^(]+) \(([a-z]{2})\)$/);
        if (countryMatch) {
            currentCountry = countryMatch[1].trim();
            continue;
        }

        // 城市行：City, State (code) @ lat°N, lng°W 或 City (code) @ lat°N, lng°W
        const cityMatch = line.match(/^\t([^(]+) \(([a-z]{3})\) @/);
        if (cityMatch) {
            currentCity = cityMatch[1].trim();
            continue;
        }

        // 服务器行：hostname (ip, ipv6) - protocol, hosted by provider
        const serverMatch = line.match(/^\t\t([^\s]+) \(([^)]+)\) - (.+)$/);
        if (serverMatch && currentCountry && currentCity) {
            const hostname = serverMatch[1].trim();
            const ipInfo = serverMatch[2];
            const protocol = serverMatch[3];

            // 提取IPv4地址
            const ipv4Match = ipInfo.match(/(\d+\.\d+\.\d+\.\d+)/);
            if (ipv4Match) {
                servers.push({
                    hostname: hostname,
                    ipv4_addr_in: ipv4Match[1],
                    country_name: currentCountry,
                    city_name: currentCity,
                    protocol: protocol,
                    active: true
                });
            }
        }
    }

    return servers;
}

// 测试服务器延迟
function testLatency(ip, timeout = 10000) {
    try {
        // 使用ping命令测试延迟，设置10秒超时
        const pingCommand = `ping -c 1 -W 10 ${ip}`;
        const output = execSync(pingCommand, { timeout: timeout, encoding: 'utf8' });

        // 解析ping输出中的延迟时间
        // 查找类似 "time=12.3 ms" 的模式
        const timeMatch = output.match(/time=([\d.]+)\s*ms/);
        if (timeMatch) {
            return parseFloat(timeMatch[1]);
        }

        // 如果没有找到time=，尝试从rtt统计中提取
        const rttMatch = output.match(/rtt min\/avg\/max\/mdev = ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+) ms/);
        if (rttMatch) {
            return parseFloat(rttMatch[2]); // 使用平均值
        }

        return null;
    } catch (error) {
        // 如果ping失败或超时，返回-1表示超时
        return -1;
    }
}

// 生成HTML报告
function generateHTML(displayResults, allResults, countryFilter) {
    const timestamp = new Date().toLocaleString('zh-CN');

    // 按延迟排序（有效的延迟在前，无效的在后）
    displayResults.sort((a, b) => {
        if (a.latency === null && b.latency === null) return 0;
        if (a.latency === null) return 1;
        if (b.latency === null) return -1;
        return a.latency - b.latency;
    });

    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mullvad VPN 节点速度测试报告</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #2c3e50;
            text-align: center;
            margin-bottom: 30px;
        }
        .stats {
            display: flex;
            justify-content: space-around;
            margin-bottom: 20px;
            padding: 15px;
            background: #ecf0f1;
            border-radius: 5px;
        }
        .stat {
            text-align: center;
        }
        .stat-number {
            font-size: 24px;
            font-weight: bold;
            color: #e74c3c;
        }
        .stat-label {
            color: #7f8c8d;
            font-size: 14px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
        }
        th, td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #ddd;
        }
        th {
            background-color: #34495e;
            color: white;
            font-weight: 600;
        }
        tr:nth-child(even) {
            background-color: #f8f9fa;
        }
        tr:hover {
            background-color: #e8f4f8;
        }
        .latency {
            font-weight: bold;
        }
        .latency.good {
            color: #27ae60;
        }
        .latency.medium {
            color: #f39c12;
        }
        .latency.bad {
            color: #e74c3c;
        }
        .latency.unknown {
            color: #95a5a6;
        }
        .country {
            font-weight: 500;
        }
        .city {
            color: #7f8c8d;
        }
        .timestamp {
            text-align: center;
            color: #7f8c8d;
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
        }
        .threshold-info {
            background: #d4edda;
            color: #155724;
            padding: 10px;
            border-radius: 4px;
            margin-bottom: 20px;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Mullvad VPN 节点速度测试报告</h1>

        <div class="threshold-info">
            10秒超时测试 | 显示所有节点${countryFilter ? ` | 筛选国家: ${countryFilter}` : ''} | 测试时间: ${timestamp}
        </div>

        <div class="stats">
            <div class="stat">
                <div class="stat-number">${allResults.filter(r => r.latency !== null && r.latency !== -1).length}</div>
                <div class="stat-label">可达节点</div>
            </div>
            <div class="stat">
                <div class="stat-number">${allResults.filter(r => r.latency === -1).length}</div>
                <div class="stat-label">超时节点</div>
            </div>
            <div class="stat">
                <div class="stat-number">${allResults.length}</div>
                <div class="stat-label">总节点数</div>
            </div>
        </div>

        <div style="margin-bottom: 15px;">
            <button onclick="sortTable('latency')" style="padding: 8px 16px; margin-right: 10px; background: #3498db; color: white; border: none; border-radius: 4px; cursor: pointer;">按延迟排序</button>
            <button onclick="sortTable('country')" style="padding: 8px 16px; margin-right: 10px; background: #2ecc71; color: white; border: none; border-radius: 4px; cursor: pointer;">按国家排序</button>
            <button onclick="sortTable('city')" style="padding: 8px 16px; background: #e74c3c; color: white; border: none; border-radius: 4px; cursor: pointer;">按城市排序</button>
        </div>

        <table id="resultsTable">
            <thead>
                <tr>
                    <th>国家</th>
                    <th>城市</th>
                    <th>服务器</th>
                    <th data-sort="latency">延迟 (ms)</th>
                    <th>IP地址</th>
                </tr>
            </thead>
            <tbody>
                ${displayResults.map(server => {
                    let latencyClass = 'unknown';
                    let latencyText = '无法连接';

                    // 显示延迟值，四舍五入到整数，或者显示超时
                    let displayLatency;
                    if (server.latency === -1) {
                        latencyClass = 'unknown';
                        displayLatency = "超时";
                    } else if (server.latency !== null) {
                        if (server.latency <= 200) {
                            latencyClass = 'good';
                        } else if (server.latency <= 1000) {
                            latencyClass = 'medium';
                        } else {
                            latencyClass = 'bad';
                        }
                        displayLatency = `${Math.max(1, Math.round(server.latency))}ms`;
                    }
                    latencyText = displayLatency;

                    return `
                        <tr>
                            <td class="country">${server.country_name || server.country_code}</td>
                            <td class="city">${server.city_name || server.city_code || '-'}</td>
                            <td>${server.hostname}</td>
                            <td class="latency ${latencyClass}">${latencyText}</td>
                            <td>${server.ipv4_addr_in}</td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>

        <div class="timestamp">
            报告生成时间: ${timestamp}
        </div>
    </div>

    <script>
        let sortDirection = {
            latency: 'asc',
            country: 'asc',
            city: 'asc'
        };

        function sortTable(column) {
            const table = document.getElementById('resultsTable');
            const tbody = table.querySelector('tbody');
            const rows = Array.from(tbody.querySelectorAll('tr'));

            rows.sort((a, b) => {
                let aVal, bVal;

                if (column === 'latency') {
                    const aText = a.cells[3].textContent;
                    const bText = b.cells[3].textContent;

                    // 超时的节点排在最后
                    if (aText === '超时' && bText !== '超时') return 1;
                    if (aText !== '超时' && bText === '超时') return -1;
                    if (aText === '超时' && bText === '超时') return 0;

                    aVal = parseFloat(aText);
                    bVal = parseFloat(bText);
                } else if (column === 'country') {
                    aVal = a.cells[0].textContent.toLowerCase();
                    bVal = b.cells[0].textContent.toLowerCase();
                } else if (column === 'city') {
                    aVal = a.cells[1].textContent.toLowerCase();
                    bVal = b.cells[1].textContent.toLowerCase();
                }

                if (sortDirection[column] === 'asc') {
                    return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
                } else {
                    return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
                }
            });

            // 切换排序方向
            sortDirection[column] = sortDirection[column] === 'asc' ? 'desc' : 'asc';

            // 重新添加排序后的行
            rows.forEach(row => tbody.appendChild(row));
        }

        // 默认按延迟排序
        window.onload = function() {
            sortTable('latency');
        };
    </script>
</body>
</html>`;

    return html;
}

// 主函数
async function main() {
    const args = process.argv.slice(2);
    let countryFilter = null;

    // 解析命令行参数
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.toLowerCase() === '--country' || arg.toLowerCase() === '-c') {
            if (i + 1 < args.length) {
                countryFilter = args[i + 1].toLowerCase();
                i++; // 跳过下一个参数
            }
        }
    }

    console.log(`开始获取Mullvad服务器列表...`);
    if (countryFilter) {
        console.log(`筛选国家: ${countryFilter}`);
    }
    console.log(`10秒超时测试`);

    try {
        let servers = await getMullvadServers();

        // 应用国家筛选
        if (countryFilter) {
            servers = servers.filter(server =>
                server.country_name.toLowerCase().includes(countryFilter) ||
                (server.country_code && server.country_code.toLowerCase() === countryFilter)
            );
        }

        console.log(`找到 ${servers.length} 个服务器`);

        const results = [];
        let tested = 0;

        console.log('开始测试延迟...\n');

        for (const server of servers) {
            if (server.ipv4_addr_in && server.active) {
                const latency = testLatency(server.ipv4_addr_in);
                results.push({
                    ...server,
                    latency: latency
                });

                tested++;
                const progress = Math.round((tested / servers.length) * 100);
                process.stdout.write(`\r已测试: ${tested}/${servers.length} (${progress}%)`);

                // 短暂延迟避免过于频繁的ping
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }

        console.log('\n\n生成HTML报告...');

        // 按延迟排序（有效的延迟在前，超时的在后）
        const sortedResults = results.sort((a, b) => {
            // 超时的节点（latency === -1）放在最后
            if (a.latency === -1 && b.latency !== -1) return 1;
            if (a.latency !== -1 && b.latency === -1) return -1;

            // 都有效的情况下，按延迟排序
            if (a.latency !== -1 && b.latency !== -1) {
                return a.latency - b.latency;
            }

            return 0;
        });

        const html = generateHTML(sortedResults, results, countryFilter);
        const filename = `mullvad-speed-test.html`;
        fs.writeFileSync(filename, html);

        console.log(`报告已生成: ${filename}`);
        console.log(`在浏览器中打开 ${filename} 查看结果`);

        // 显示前10个最快的结果
        const validResults = results.filter(r => r.latency !== null).sort((a, b) => a.latency - b.latency);
        console.log('\n最快的10个节点:');
        validResults.slice(0, 10).forEach((server, index) => {
            let displayLatency;
            if (server.latency === -1) {
                displayLatency = "超时";
            } else {
                displayLatency = `${Math.max(1, Math.round(server.latency))}ms`;
            }
            console.log(`${index + 1}. ${server.hostname} (${server.country_name || server.country_code}) - ${displayLatency}`);
        });

    } catch (error) {
        console.error('发生错误:', error.message);
        process.exit(1);
    }
}

main();
