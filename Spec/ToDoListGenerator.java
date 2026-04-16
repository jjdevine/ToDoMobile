package org.example;

import java.io.*;
import java.nio.file.*;
import java.text.DateFormat;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.time.format.TextStyle;
import java.time.temporal.TemporalAdjusters;
import java.util.*;
import java.util.regex.*;

/**
 * Hello world!
 *
 */
public class ToDoListGenerator
{
    enum Freq { WEEKLY, MONTHLY }

    static final Pattern LINE = Pattern.compile("^\\s*(.+?)\\s*-\\s*(weekly|monthly)\\s*-\\s*(.+?)\\s*$", Pattern.CASE_INSENSITIVE);
    static final Locale LOCALE = Locale.ENGLISH;

    record Task(String name, Freq freq, List<String> clarList) {}

    public static void main(String[] args) throws Exception {
        Path input = Paths.get(args.length > 0 ? args[0] : "tasks.txt");
        List<Task> tasks = parseTasks(input);

        LocalDate today = LocalDate.now();
        LocalDate currStart = today.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
        LocalDate nextStart = currStart.plusWeeks(1);

        System.out.println("Current week: " + currStart + " to " + currStart.plusDays(6));
        printWeek(tasks, currStart);


        System.out.print("Generate next week's list? (y/n): ");
        Scanner sc = new Scanner(System.in);
        String answer = sc.nextLine().trim().toLowerCase(Locale.ENGLISH);
        if (answer.equals("y") || answer.equals("yes")) {
            System.out.println();
            System.out.println("Next week: " + nextStart + " to " + nextStart.plusDays(6));
            printWeek(tasks, nextStart);
        } else {
            System.out.println("Next week skipped.");
        }

        LocalDate startDate = currStart;

        for(int week =0; week <=1; week ++) {
            System.out.println("\n\n***\n\n");
            System.out.println("Monday " + getFormattedDate(startDate, week*7 ));
            System.out.println("Tuesday " + getFormattedDate(startDate, 1 + (week*7) ));
            System.out.println("Wednesday " + getFormattedDate(startDate, 2 + (week*7) ));
            System.out.println("Thursday " + getFormattedDate(startDate, 3 + (week*7) ));
            System.out.println("Friday " + getFormattedDate(startDate, 4 + (week*7) ));
            System.out.println("Saturday " + getFormattedDate(startDate, 5 + (week*7) ));
            System.out.println("Sunday " + getFormattedDate(startDate, 6 + (week*7) ));
        }

    }

    public static String getFormattedDate(LocalDate date, int plusDays) {
        LocalDate dateToFormat = date.plusDays(plusDays);
        DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
        return dateToFormat.format(formatter);
    }


    static List<Task> parseTasks(Path p) throws IOException {
        List<Task> out = new ArrayList<>();
        if (!Files.exists(p)) {
            System.err.println("Input file not found: " + p.toAbsolutePath());
            System.exit(1);
        }
        List<String> lines = Files.readAllLines(p);
        for (int i = 0; i < lines.size(); i++) {
            String raw = lines.get(i);
            String line = raw.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;
            Matcher m = LINE.matcher(line);
            if (!m.matches()) {
                System.err.println("Skip invalid line " + (i + 1) + ": " + raw);
                continue;
            }
            String name = m.group(1).trim();
            String f = m.group(2).trim().toLowerCase(LOCALE);
            String clar = m.group(3).trim();
            Freq freq = f.equals("weekly") ? Freq.WEEKLY : Freq.MONTHLY;
            List<String> clarList = Arrays.stream(clar.split(","))
                    .map(String::trim)
                    .filter(s -> !s.isEmpty())
                    .toList();
            out.add(new Task(name, freq, clarList));
        }
        return out;
    }

    static void printWeek(List<Task> tasks, LocalDate weekStartMonday) {
        Map<DayOfWeek, List<String>> plan = new LinkedHashMap<>();
        for (DayOfWeek dow : DayOfWeek.values()) plan.put(dow, new ArrayList<>());

        Map<DayOfWeek, LocalDate> dateByDow = new EnumMap<>(DayOfWeek.class);
        for (int i = 0; i < 7; i++) {
            LocalDate d = weekStartMonday.plusDays(i);
            dateByDow.put(d.getDayOfWeek(), d);
        }

        for (Task t : tasks) {
            switch (t.freq) {
                case WEEKLY -> {
                    for (String clar : t.clarList) {
                        DayOfWeek dow = parseDayOfWeek(clar);
                        if (dow != null) plan.get(dow).add(t.name);
                        else System.err.println("Unknown day for weekly task \"" + t.name + "\": " + clar);
                    }
                }
                case MONTHLY -> {
                    for (String clar : t.clarList) {
                        Integer dom = parseDayOfMonth(clar);
                        if (dom == null) {
                            System.err.println("Bad day-of-month for monthly task \"" + t.name + "\": " + clar);
                            continue;
                        }
                        for (Map.Entry<DayOfWeek, LocalDate> e : dateByDow.entrySet()) {
                            if (e.getValue().getDayOfMonth() == dom) {
                                plan.get(e.getKey()).add(t.name);
                                break;
                            }
                        }
                    }
                }
            }
        }

        for (DayOfWeek dow : DayOfWeek.values()) {
            String header = dow.getDisplayName(TextStyle.FULL, LOCALE);
            System.out.println(header);
            System.out.println();
            List<String> items = plan.get(dow);
            for (String it : items) System.out.println(it);
            System.out.println();
        }
    }

    static DayOfWeek parseDayOfWeek(String s) {
        String k = s.trim().toLowerCase(LOCALE);
        for (DayOfWeek d : DayOfWeek.values()) {
            String full = d.getDisplayName(TextStyle.FULL, LOCALE).toLowerCase(LOCALE);
            String short3 = d.getDisplayName(TextStyle.SHORT, LOCALE).toLowerCase(LOCALE);
            if (k.equals(full) || k.equals(short3)) return d;
        }
        return switch (k) {
            case "mon" -> DayOfWeek.MONDAY;
            case "tue", "tues" -> DayOfWeek.TUESDAY;
            case "wed" -> DayOfWeek.WEDNESDAY;
            case "thu", "thur", "thurs" -> DayOfWeek.THURSDAY;
            case "fri" -> DayOfWeek.FRIDAY;
            case "sat" -> DayOfWeek.SATURDAY;
            case "sun" -> DayOfWeek.SUNDAY;
            default -> null;
        };
    }

    static Integer parseDayOfMonth(String s) {
        try {
            int n = Integer.parseInt(s.trim());
            if (n >= 1 && n <= 31) return n;
            return null;
        } catch (NumberFormatException e) {
            return null;
        }
    }
}