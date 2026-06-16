from greeter import Greeter, make_greeter


def main():
    greeter = make_greeter("World")
    message = greeter.greet()
    print(message)
