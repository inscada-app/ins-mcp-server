# inSCADA Chat - Project Reference

## Overview
Express.js + Claude API chat app with 22 tools for querying PostgreSQL (inscada), InfluxDB, and generating Charts.

## Key Files
- `server.js` - Express server, routes, Claude API integration
- `tools.js` - Tool definitions (JSON schemas for Claude)
- `tool-handlers.js` - Tool execution logic (SQL, InfluxQL, chart rendering)
- `mcp-server.mjs` - MCP server for external tool access
- `public/` - Frontend (HTML/CSS/JS chat UI)

## InfluxDB Data Model
- **Main measurement**: `variable_value` in retention policy `variable_value_rp`
  - Query pattern: `SELECT ... FROM "variable_value_rp"."variable_value" WHERE ...`
  - **Tags**: name, node_id, project, project_id, space, space_id, variable_id
  - **Field**: value (float)
- **Other measurements**: `auth_attempt`, `event_log`, `fired_alarm` (same RP convention: `{m}_rp.{m}`)
- **Example variable names**: AN01_Active_Power, AN01_Reactive_Power, AN01_Wind_Speed

## PostgreSQL Schema (inscada)
> Convention: most tables have `insert_user, insert_dttm, version_user, version_dttm, space_id`

### Core Hierarchy
```
space(space_id PK, name, insert_user, insert_dttm, version_user, version_dttm)

project(project_id PK, name, dsc, address, latitude, longitude, contract_day, contract_hour,
  active_flag, properties, icon, space_id, insert_user/dttm, version_user/dttm)

script(script_id PK, project_id->project, name, dsc, code TEXT, sch_type, period, delay,
  sch_time, off_set, log_flag, owner_id->users, space_id, insert/version_user/dttm)

script_history(history_id PK, script_id->script, name, code TEXT, changed_by, changed_at, change_reason)

connection(conn_id PK, project_id->project, name, dsc, protocol, ip, port,
  owner_id->users, space_id, insert/version_user/dttm)

device(device_id PK, conn_id->connection, name, dsc, properties TEXT, space_id, insert/version_user/dttm)

frame(frame_id PK, device_id->device, name, dsc, minutes_offset, scan_time_factor,
  readable_flag, writable_flag, space_id, insert/version_user/dttm)

variable(variable_id PK, frame_id->frame, project_id->project, name, dsc, code,
  value_expression TEXT, value_expression_type, value_expression_id->expression,
  fractional_digit_count, raw_zero_scale, raw_full_scale, eng_zero_scale, eng_full_scale,
  unit, log_type, log_period, log_threshold, log_expression, log_expression_id->expression,
  log_min_value, log_max_value, set_min_value, set_max_value,
  active_flag, pulse_on_flag, pulse_off_flag, pulse_on_duration, pulse_off_duration,
  keep_last_values, space_id, insert/version_user/dttm)
```

### Alarms
```
alarm_group(alarm_group_id PK, project_id->project, name, dsc, scan_time, priority,
  on/off/ack_script_id->script, on_no_ack_color, on_ack_color, off_no_ack_color, off_ack_color,
  printer_ip, printer_port, print_when_on/off/ack, hidden_on_monitor, owner_id->users, space_id)

alarm(alarm_id PK, project_id->project, name, dsc, delay, group_id->alarm_group,
  active_flag, part, on_time_variable_id->variable, off_time_variable_id->variable, space_id)

analog_alarm(alarm_id PK/FK->alarm, variable_id->variable, set_point_value, high_high_value,
  high_value, low_value, low_low_value, dead_band, deviation_percentage)

digital_alarm(alarm_id PK/FK->alarm, variable_a_id->variable, variable_b_id->variable,
  variable_a/b_inverted, and_calc, variable_a/b_bit_offset)

custom_alarm(alarm_id PK/FK->alarm, condition)
```

### Visualization
```
animation(animation_id PK, project_id->project, name, dsc, svg_content TEXT, anim_join_id,
  color, duration, play_order, main_flag, pre/post_anim_code, configs, alignment, placeholders, space_id)
animation_element(anim_element_id PK, animation_id->animation, name, dsc, expression TEXT,
  expression_type, type, dom_id, props TEXT, status_flag, space_id)
animation_script(animation_script_id PK, animation_id, type, script_id->script, space_id)

faceplate(faceplate_id PK, project_id->project, name, dsc, svg_content TEXT, color, space_id)
faceplate_element(faceplate_element_id PK, faceplate_id->faceplate, name, expression, expression_type, type, dom_id, props)
faceplate_placeholder(placeholder_id PK, faceplate_id->faceplate, name, type, props, placeholder_group, placeholder_order, dsc)

trend(trend_id PK, project_id->project, name, dsc, period, configs, trend_order, space_id)
trend_tag(trend_tag_id PK, trend_id->trend, name, dsc, variable_id->variable,
  min_scale, max_scale, color, thickness, status_flag, grid_thickness, hide_value_axe, tag_order, space_id)

monitor_table(monitor_table_id PK, project_id->project, name, dsc, x_count, space_id)
monitor_variable(monitor_variable_id PK, monitor_table_id, type, sort_order, variable_id->variable, space_id)

board_group(board_group_id PK, name, color, rank, space_id)
board(board_id PK, board_group_id->board_group, type, x, y, width, height, config TEXT, header, space_id)
symbol(symbol_id PK, name, dsc, content TEXT, space_id)
```

### Reports
```
report(report_id PK, project_id->project, name, dsc, no, period, report_day, report_time,
  print_flag, print_day, print_time, lang, mail_flag, mail_day, mail_time, mail_to,
  logo_flag, minutes, owner_id->users, space_id)
report_group(report_group_id PK, name, report_id->report, group_order, space_id)
report_subgroup(report_subgroup_id PK, name, report_group_id->report_group, subgroup_order, space_id)
report_variable(report_variable_id PK, name, report_subgroup_id->report_subgroup, calc_type,
  variable_order, variable_id->variable, total_variable_id->variable, deviation_variable_id->variable,
  total_calc_type, deviation_calc_report_variable_id->report_variable, pattern, space_id)

jasper_report(jasper_report_id PK, project_id->project, name, dsc, template_file, parameters, datasource, subreports, space_id)
jspdf_report(jspdf_report_id PK, project_id->project, name, dsc, script TEXT, space_id)
```

### Users & Auth
```
users(user_id PK, username, passwd, email, phone, otp_type, require_password_reset, eula_accepted)
roles(role_id PK, name)
permissions(permission_id PK, name)
role_members(role_id->roles, user_id->users)  -- composite PK
role_menus(role_id->roles, menu_id->menus)     -- composite PK
role_permissions(role_id->roles, permission_id->permissions) -- composite PK
menus(menu_id PK, name)
space_users(space_id, user_id)  -- composite PK
```

### Communication Protocols
Each protocol has `{proto}_connection`, `{proto}_device`, `{proto}_frame`, `{proto}_variable` tables extending the base connection/device/frame/variable via shared PK:
- **modbus_** (timeout, pool_size, retries, station_address, scan_time, type, start_address, quantity, byte/word_swap)
- **s7_** (rack, slot, type, db_number, start_address, bit_offset)
- **opc_ua_** (server_name, security_mode/policy, username/password, namespace_index, identifier)
- **opc_da_** (com_prog_id, separator, max_depth, percent_deadband, subscription_mode)
- **opc_xml_** (connect_timeout, request_timeout, path, wait_time, hold_time)
- **iec104_** (cot/ca/ioa_field_length, common_address, read/write_address)
- **iec61850_** (local_ip/port, response_timeout, object_reference, fc)
- **dnp3_** (adapter, pool_size, local/remote_address, point_class, static/event_variation)
- **ethernet_ip_** (timeout, retries, slot, scan_time)
- **fatek_** (timeout, station_address, type, start_address)
- **mqtt_** (identifier, username/password, use_ssl, base_topic, topic, qos, subscribe/publish_expression)
- **local_** (scan_time, scan_type, type)

### Other Tables
```
expression(expression_id PK, name, dsc, code TEXT, space_id)
data_transfer(data_transfer_id PK, project_id, name, dsc, period, owner_id->users, space_id)
data_transfer_detail(data_transfer_detail_id PK, data_transfer_id->data_transfer,
  source_var_id->variable, target_var_id->variable, calc_type, range_type, threshold, space_id)
custom_datasource(custom_datasource_id PK, project_id->project, name, dsc, url, username, password, space_id)
custom_query(custom_query_id PK, project_id->project, name, dsc, query_str TEXT, space_id)
custom_table(custom_table_id PK, name, space_id)
custom_table_field(custom_table_field_id PK, custom_table_id->custom_table, field_name, field_type, field_length, required, default_value, sort_order)
custom_menu(custom_menu_id PK, name, icon, target, position, content_type, content, parent_id->custom_menu, menu_order, space_id)
map_variable(map_variable_id PK, project_id->project, variable_id->variable, var_order, space_id)
trace_table(trace_table_id PK, project_id->project, name, config TEXT, space_id)
keyword(keyword_id PK, type, key, dsc, active, props TEXT, space_id)
language(language_id PK, lang, key, value, dsc, space_id)
project_attachment(project_attachment_id PK, project_id, name, dsc, file_name, file_size, file_type, data BYTEA, space_id)
```

## Key FK Relationship Chains
```
space -> project -> script, variable, connection, alarm_group, alarm, report, animation, faceplate, trend, monitor_table, jasper_report, jspdf_report, custom_datasource, custom_query, trace_table, map_variable
connection -> device -> frame -> variable
alarm_group -> alarm -> analog_alarm | digital_alarm | custom_alarm
report -> report_group -> report_subgroup -> report_variable -> variable
trend -> trend_tag -> variable
script_history -> script
board_group -> board
roles -> role_members -> users
roles -> role_permissions -> permissions
roles -> role_menus -> menus
```

## Common Query Patterns
- Join variable to project: `variable v JOIN project p ON v.project_id = p.project_id`
- Join variable through frame/device/connection: `variable v JOIN frame f ON v.frame_id=f.frame_id JOIN device d ON f.device_id=d.device_id JOIN connection c ON d.conn_id=c.conn_id`
- Filter by space: `WHERE space_id = ?` (nearly all tables have space_id)
- Get protocol details: `JOIN modbus_variable mv ON v.variable_id=mv.variable_id` (use matching protocol)
