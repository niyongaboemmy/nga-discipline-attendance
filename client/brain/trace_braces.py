with open(r'C:\Users\user\Downloads\MIS-2\client\src\pages\Dashboard.tsx', 'r', encoding='utf-8') as f:
    lines = f.readlines()

stack = []
for idx, line in enumerate(lines):
    line_num = idx + 1
    if line_num < 40 or line_num > 160:
        continue
    
    clean_line = ""
    for char in line:
        if char in ['{', '}']:
            clean_line += char
            
    for char in clean_line:
        if char == '{':
            stack.append(line_num)
            print(f"[{line_num}] PUSH '{{'. Stack: {stack}")
        elif char == '}':
            if stack:
                o = stack.pop()
                print(f"[{line_num}] POP '}}' (closes line {o}). Stack: {stack}")
            else:
                print(f"[{line_num}] POP '}}' (extra closing!). Stack: {stack}")
