with open(r'C:\Users\user\Downloads\MIS-2\client\src\pages\Dashboard.tsx', 'r', encoding='utf-8') as f:
    lines = f.readlines()

stack = []
for idx, line in enumerate(lines):
    line_num = idx + 1
    # Strip string literals and comments to avoid matching fake curlies
    clean_line = ""
    in_string = False
    string_char = ""
    in_comment = False
    in_multiline_comment = False
    
    char_idx = 0
    while char_idx < len(line):
        char = line[char_idx]
        if in_multiline_comment:
            if char == '*' and char_idx + 1 < len(line) and line[char_idx+1] == '/':
                in_multiline_comment = False
                char_idx += 2
                continue
        elif in_comment:
            break
        elif in_string:
            if char == string_char:
                if char_idx > 0 and line[char_idx-1] == '\\':
                    pass # escaped
                else:
                    in_string = False
        else:
            if char == '/' and char_idx + 1 < len(line) and line[char_idx+1] == '/':
                in_comment = True
                break
            elif char == '/' and char_idx + 1 < len(line) and line[char_idx+1] == '*':
                in_multiline_comment = True
                char_idx += 2
                continue
            elif char in ['"', "'", '`']:
                in_string = True
                string_char = char
            elif char in ['{', '}']:
                clean_line += char
        char_idx += 1

    for char in clean_line:
        if char == '{':
            stack.append(line_num)
        elif char == '}':
            if not stack:
                print(f"Extra closing curly '}}' at line {line_num}")
            else:
                o_line = stack.pop()
                if line_num >= 140 and line_num <= 155:
                    print(f"Closed curly from line {o_line} at line {line_num}")

print("Stack size at end:", len(stack))
if stack:
    print("Open lines:")
    for o_line in stack:
        print(f"Line {o_line}: {lines[o_line-1].strip()}")
