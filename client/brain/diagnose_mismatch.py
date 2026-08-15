with open(r'C:\Users\user\Downloads\MIS-2\client\src\pages\Dashboard.tsx', 'r', encoding='utf-8') as f:
    lines = f.readlines()

stack = []
for idx, line in enumerate(lines):
    line_num = idx + 1
    # Strip comments and strings
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
            stack.append((line_num, line.strip()))
        elif char == '}':
            if not stack:
                print(f"ERROR: Extra closing curly '}}' at line {line_num}: {line.strip()}")
            else:
                o_line, o_text = stack.pop()

print("Stack size at end:", len(stack))
if stack:
    print("Currently open blocks (unclosed at end of file):")
    for o_line, o_text in stack:
        print(f"Line {o_line}: {o_text}")
